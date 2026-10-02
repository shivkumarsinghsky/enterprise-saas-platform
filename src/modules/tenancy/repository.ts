import { type Tx } from "../../platform/db.js";
import type { TenantRecord } from "./context.js";
import type { FeatureGrant, FeatureOverride } from "./entitlements.js";

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantRecord["status"];
  region: string;
  plan_id: string;
  placement: string;
  settings: Record<string, unknown>;
}

const toRecord = (r: TenantRow): TenantRecord => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  status: r.status,
  region: r.region,
  planId: r.plan_id,
  placement: r.placement,
  settings: r.settings,
});

/** Control-plane queries (pooled cluster). */
export const tenantRepository = {
  async byId(tx: Tx, id: string): Promise<TenantRecord | undefined> {
    const { rows } = await tx.query<TenantRow>("SELECT * FROM tenants WHERE id = $1", [id]);
    return rows[0] && toRecord(rows[0]);
  },
  async bySlug(tx: Tx, slug: string): Promise<TenantRecord | undefined> {
    const { rows } = await tx.query<TenantRow>("SELECT * FROM tenants WHERE slug = $1", [slug]);
    return rows[0] && toRecord(rows[0]);
  },
  async list(tx: Tx): Promise<TenantRecord[]> {
    const { rows } = await tx.query<TenantRow>("SELECT * FROM tenants ORDER BY created_at");
    return rows.map(toRecord);
  },
  async listActiveOnPlacement(tx: Tx, placement: string): Promise<TenantRecord[]> {
    const { rows } = await tx.query<TenantRow>(
      "SELECT * FROM tenants WHERE placement = $1 AND status = 'ACTIVE'",
      [placement],
    );
    return rows.map(toRecord);
  },
  async insert(tx: Tx, t: Omit<TenantRecord, "settings">): Promise<void> {
    await tx.query(
      "INSERT INTO tenants (id, slug, name, status, region, plan_id, placement) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [t.id, t.slug, t.name, t.status, t.region, t.planId, t.placement],
    );
  },
  async update(
    tx: Tx,
    id: string,
    patch: { status?: string; planId?: string; settings?: unknown },
  ): Promise<void> {
    await tx.query(
      `UPDATE tenants SET status = COALESCE($2, status), plan_id = COALESCE($3, plan_id),
              settings = COALESCE($4, settings) WHERE id = $1`,
      [
        id,
        patch.status ?? null,
        patch.planId ?? null,
        patch.settings === undefined ? null : JSON.stringify(patch.settings),
      ],
    );
  },
  async planExists(tx: Tx, planId: string): Promise<boolean> {
    return ((await tx.query("SELECT 1 FROM plans WHERE id = $1", [planId])).rowCount ?? 0) > 0;
  },
  async planFeatures(tx: Tx, planId: string): Promise<FeatureGrant[]> {
    const { rows } = await tx.query<{ feature_key: string; limit_value: number | null }>(
      "SELECT feature_key, limit_value FROM plan_features WHERE plan_id = $1",
      [planId],
    );
    return rows.map((r) => ({ featureKey: r.feature_key, limitValue: r.limit_value }));
  },
  async overrides(tx: Tx, tenantId: string): Promise<FeatureOverride[]> {
    const { rows } = await tx.query<{ feature_key: string; limit_value: number | null; enabled: boolean }>(
      "SELECT feature_key, limit_value, enabled FROM tenant_feature_overrides WHERE tenant_id = $1",
      [tenantId],
    );
    return rows.map((r) => ({ featureKey: r.feature_key, limitValue: r.limit_value, enabled: r.enabled }));
  },
  async setOverride(tx: Tx, tenantId: string, o: FeatureOverride): Promise<void> {
    await tx.query(
      `INSERT INTO tenant_feature_overrides (tenant_id, feature_key, enabled, limit_value) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, limit_value = EXCLUDED.limit_value`,
      [tenantId, o.featureKey, o.enabled, o.limitValue],
    );
  },
};
