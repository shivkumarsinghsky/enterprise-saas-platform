import { randomUUID } from "node:crypto";
import { type TenantRouter, withControlPlane, withTenant } from "../../platform/db.js";
import type { Logger } from "../../platform/logger.js";
import type { Metrics } from "../../platform/metrics.js";
import { tenantRepository } from "../tenancy/repository.js";

const TEMPLATES: Record<
  string,
  (payload: Record<string, string>) => { recipient: string; template: string }
> = {
  TenantProvisioned: (p) => ({ recipient: p.adminEmail!, template: "tenant-welcome" }),
  UserInvited: (p) => ({ recipient: p.email!, template: "user-invitation" }),
};

/**
 * Processes outbox events into notifications (a stand-in for an email provider or a message broker).
 *
 * It runs with the same RLS-restricted database role as the API and processes **one tenant per transaction**
 * (setting the tenant context), so no component needs cross-tenant data access. Trade-off: one query per
 * active tenant per poll; at large tenant counts, switch to change data capture or a dedicated worker role.
 * `FOR UPDATE SKIP LOCKED` lets several dispatcher replicas run concurrently.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly router: TenantRouter,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch((err) => this.log.error({ err }, "outbox dispatch failed"));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Dispatch pending events for every active tenant; returns the number processed. */
  async runOnce(): Promise<number> {
    let processed = 0;
    for (const placement of this.router.placements()) {
      const tenants = await withControlPlane(this.router, (tx) =>
        tenantRepository.listActiveOnPlacement(tx, placement),
      );
      for (const tenant of tenants) {
        processed += await withTenant(this.router, tenant, async (tx) => {
          const { rows } = await tx.query<{ id: string; type: string; payload: Record<string, string> }>(
            `SELECT id, type, payload FROM outbox WHERE processed_at IS NULL ORDER BY created_at LIMIT 50
               FOR UPDATE SKIP LOCKED`,
          );
          for (const event of rows) {
            const render = TEMPLATES[event.type];
            if (render) {
              const { recipient, template } = render(event.payload);
              await tx.query(
                `INSERT INTO notifications (id, tenant_id, recipient, template, source_event_id) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (source_event_id) DO NOTHING`,
                [randomUUID(), tenant.id, recipient, template, event.id],
              );
              this.log.info({ tenantId: tenant.id, template, eventId: event.id }, "notification dispatched");
            }
            await tx.query("UPDATE outbox SET processed_at = now() WHERE id = $1", [event.id]);
            this.metrics.outboxDispatched.inc({ type: event.type });
          }
          return rows.length;
        });
      }
    }
    return processed;
  }
}
