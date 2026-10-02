import { randomUUID } from "node:crypto";
import type { Tx } from "../../platform/db.js";

export type DomainEvent =
  | { type: "TenantProvisioned"; payload: { tenantName: string; adminEmail: string } }
  | { type: "UserInvited"; payload: { userId: string; email: string; displayName: string } };

/** Stage a domain event in the caller's transaction (transactional outbox). */
export async function enqueueEvent(
  tx: Tx,
  tenantId: string,
  event: DomainEvent,
  correlationId?: string,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO outbox (id, tenant_id, type, payload, correlation_id) VALUES ($1,$2,$3,$4,$5)",
    [id, tenantId, event.type, JSON.stringify(event.payload), correlationId ?? null],
  );
  return id;
}
