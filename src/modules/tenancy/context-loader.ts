import { TtlCache, tenantKey } from "../../platform/cache.js";
import { type TenantRouter, withControlPlane, withTenant } from "../../platform/db.js";
import { AppError, forbidden, unauthorized } from "../../platform/errors.js";
import { effectivePermissions, type Permission } from "../rbac/permissions.js";
import type { TenantContext, TenantRecord } from "./context.js";
import { computeEntitlements, type Entitlements } from "./entitlements.js";
import { tenantRepository } from "./repository.js";

/**
 * Resolves the tenant context for an authenticated request. Tenant records, entitlements and user permissions
 * are cached briefly (tenant-prefixed keys) and invalidated on local writes.
 */
export class ContextLoader {
  private readonly tenants = new TtlCache<TenantRecord | undefined>(30_000);
  private readonly entitlements = new TtlCache<Entitlements>(30_000);
  private readonly permissions = new TtlCache<Set<Permission> | null>(30_000);

  constructor(private readonly router: TenantRouter) {}

  async load(claims: { sub: string; tid: string }, correlationId: string): Promise<TenantContext> {
    const tenant = await this.tenant(claims.tid);
    if (!tenant) throw unauthorized("unknown tenant");
    if (tenant.status === "SUSPENDED") throw forbidden("TENANT_SUSPENDED", "tenant is suspended");
    if (tenant.status !== "ACTIVE")
      throw new AppError(503, "TENANT_NOT_READY", "tenant is still being provisioned");

    const [entitlements, permissions] = await Promise.all([
      this.entitlements.getOrLoad(tenantKey(tenant.id, "entitlements"), () =>
        withControlPlane(this.router, async (tx) =>
          computeEntitlements(
            tenant.planId,
            await tenantRepository.planFeatures(tx, tenant.planId),
            await tenantRepository.overrides(tx, tenant.id),
          ),
        ),
      ),
      this.permissions.getOrLoad(tenantKey(tenant.id, "permissions", claims.sub), () =>
        withTenant(this.router, tenant, async (tx) => {
          const user = await tx.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [
            claims.sub,
          ]);
          if (user.rows[0]?.status !== "ACTIVE") return null;
          const { rows } = await tx.query<{ permissions: string[] }>(
            "SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1",
            [claims.sub],
          );
          return effectivePermissions(rows.map((r) => r.permissions));
        }),
      ),
    ]);
    if (!permissions) throw unauthorized("user is disabled or does not exist");
    return { tenant, userId: claims.sub, permissions, entitlements, correlationId };
  }

  tenant(tenantId: string): Promise<TenantRecord | undefined> {
    return this.tenants.getOrLoad(tenantKey(tenantId, "record"), () =>
      withControlPlane(this.router, (tx) => tenantRepository.byId(tx, tenantId)),
    );
  }

  invalidateTenant(tenantId: string): void {
    this.tenants.invalidate(tenantKey(tenantId, "record"));
    this.entitlements.invalidate(tenantKey(tenantId, "entitlements"));
    this.permissions.invalidatePrefix(tenantKey(tenantId, "permissions"));
  }

  invalidateUser(tenantId: string, userId: string): void {
    this.permissions.invalidate(tenantKey(tenantId, "permissions", userId));
  }
}
