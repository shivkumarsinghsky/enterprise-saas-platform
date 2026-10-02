import { randomUUID } from "node:crypto";
import { z } from "zod";
import { POOLED, type TenantRouter, withControlPlane, withTenant } from "../../platform/db.js";
import { AppError, conflict } from "../../platform/errors.js";
import { hashPassword } from "../../platform/passwords.js";
import { recordAudit } from "../audit/audit.js";
import { enqueueEvent } from "../notifications/outbox.js";
import { SYSTEM_ROLES } from "../rbac/permissions.js";
import type { TenantRecord } from "./context.js";
import { tenantRepository } from "./repository.js";

export const createTenantRequest = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "lowercase letters, digits and dashes, 3-40 chars"),
  name: z.string().min(1).max(200),
  plan: z.string().min(1),
  region: z.enum(["eu-west", "us-east", "ap-south"]),
  placement: z.string().default(POOLED),
  admin: z.object({
    email: z.email().transform((e) => e.toLowerCase()),
    displayName: z.string().min(1).max(200),
    password: z.string().min(12).max(200),
  }),
});
export type CreateTenantRequest = z.infer<typeof createTenantRequest>;

/**
 * Provisioning is a two-phase process because a tenant's data may live on a different cluster than the
 * control plane (placement). The tenant is created as PROVISIONING, its data (system roles, first admin,
 * audit record, welcome events) is created on its placement cluster, then it is activated.
 * A failure leaves the tenant in PROVISIONING, which blocks sign-in and is visible to operators.
 */
export async function provisionTenant(router: TenantRouter, req: CreateTenantRequest, correlationId: string) {
  const tenantId = randomUUID();
  const record: Omit<TenantRecord, "settings"> = {
    id: tenantId,
    slug: req.slug,
    name: req.name,
    status: "PROVISIONING",
    region: req.region,
    planId: req.plan,
    placement: req.placement,
  };
  if (!router.placements().includes(req.placement)) {
    throw new AppError(400, "UNKNOWN_PLACEMENT", `placement '${req.placement}' is not configured`);
  }

  await withControlPlane(router, async (tx) => {
    if (!(await tenantRepository.planExists(tx, req.plan)))
      throw new AppError(400, "UNKNOWN_PLAN", `unknown plan '${req.plan}'`);
    if (await tenantRepository.bySlug(tx, req.slug)) throw conflict(`tenant slug '${req.slug}' is taken`);
    await tenantRepository.insert(tx, record);
  });

  // A dedicated cluster needs its own copy of the tenant row for referential integrity.
  if (req.placement !== POOLED) {
    await withTenant(router, record, (tx) => tenantRepository.insert(tx, record));
  }

  const passwordHash = await hashPassword(req.admin.password);
  const adminUserId = randomUUID();
  await withTenant(router, record, async (tx) => {
    const roleIds: Record<string, string> = {};
    for (const [name, permissions] of Object.entries(SYSTEM_ROLES)) {
      roleIds[name] = randomUUID();
      await tx.query(
        "INSERT INTO roles (id, tenant_id, name, permissions, is_system) VALUES ($1,$2,$3,$4,true)",
        [roleIds[name], tenantId, name, permissions],
      );
    }
    await tx.query(
      "INSERT INTO users (id, tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4,$5)",
      [adminUserId, tenantId, req.admin.email, req.admin.displayName, passwordHash],
    );
    await tx.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      tenantId,
      adminUserId,
      roleIds["tenant-admin"],
    ]);
    await recordAudit(tx, {
      tenantId,
      actorId: "platform",
      action: "tenant.provisioned",
      resourceType: "tenant",
      resourceId: tenantId,
      details: { plan: req.plan, region: req.region, placement: req.placement },
      correlationId,
    });
    await enqueueEvent(
      tx,
      tenantId,
      { type: "TenantProvisioned", payload: { tenantName: req.name, adminEmail: req.admin.email } },
      correlationId,
    );
  });

  await withControlPlane(router, (tx) => tenantRepository.update(tx, tenantId, { status: "ACTIVE" }));
  return { tenantId, adminUserId };
}
