import pg from "pg";

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export const POOLED = "pooled";

/**
 * Routes a tenant's data access to the cluster named by its placement (ADR-002).
 * The pooled cluster also hosts the control plane (tenants, plans); dedicated clusters host only the data
 * of the tenants placed on them. Services never choose a database themselves.
 */
export class TenantRouter {
  constructor(
    readonly pooled: Pool,
    private readonly dedicated: Map<string, Pool> = new Map(),
  ) {}

  poolFor(placement: string): Pool {
    if (placement === POOLED) return this.pooled;
    const pool = this.dedicated.get(placement);
    if (!pool) throw new Error(`no database configured for placement '${placement}'`);
    return pool;
  }

  placements(): string[] {
    return [POOLED, ...this.dedicated.keys()];
  }

  async end(): Promise<void> {
    await Promise.all([this.pooled.end(), ...[...this.dedicated.values()].map((p) => p.end())]);
  }
}

async function transaction<T>(
  pool: Pool,
  setup: (tx: Tx) => Promise<void>,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setup(client);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `work` in a transaction bound to one tenant. `set_config(..., is_local => true)` scopes the setting to
 * this transaction, so a pooled connection can never leak one tenant's context into another request.
 */
export function withTenant<T>(
  router: TenantRouter,
  tenant: { id: string; placement: string },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return transaction(
    router.poolFor(tenant.placement),
    async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
    },
    work,
  );
}

/** Control-plane transaction on the pooled cluster without tenant context (platform operations only). */
export function withControlPlane<T>(router: TenantRouter, work: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(router.pooled, async () => {}, work);
}
