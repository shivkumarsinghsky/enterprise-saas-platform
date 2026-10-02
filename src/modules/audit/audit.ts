import type { Tx } from "../../platform/db.js";

export interface AuditEntry {
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Written in the same transaction as the change it describes: if the change commits, the audit record
 * commits; there is no way to make the change and skip the audit. The app role cannot UPDATE or DELETE.
 */
export async function recordAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, details, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      e.tenantId,
      e.actorId,
      e.action,
      e.resourceType,
      e.resourceId ?? null,
      JSON.stringify(e.details ?? {}),
      e.correlationId ?? null,
    ],
  );
}
