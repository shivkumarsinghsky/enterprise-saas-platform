import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenantKey } from "../../platform/cache.js";
import { withControlPlane, withTenant } from "../../platform/db.js";
import { AppError, unauthorized } from "../../platform/errors.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { DUMMY_HASH, verifyPassword } from "../../platform/passwords.js";
import { recordAudit } from "../audit/audit.js";
import { tenantRepository } from "../tenancy/repository.js";

const loginRequest = z.object({
  tenant: z.string().min(1).max(40),
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_WINDOW_SECONDS = 15 * 60;

/**
 * Tenant-aware sign-in: the tenant is part of the credential. The same email can exist in several tenants,
 * and a token is only ever valid for the tenant it was issued for.
 */
export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/auth/login", { config: { public: true } }, async (req) => {
    const body = loginRequest.parse(req.body);
    const tenant = await withControlPlane(deps.router, (tx) => tenantRepository.bySlug(tx, body.tenant));
    if (!tenant || tenant.status !== "ACTIVE") {
      await verifyPassword(body.password, DUMMY_HASH); // equalise timing
      throw unauthorized("invalid credentials");
    }

    const failuresKey = tenantKey(tenant.id, "login-failures", body.email);
    const failures = Number((await deps.redis.get(failuresKey)) ?? 0);
    if (failures >= MAX_FAILED_LOGINS) {
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "too many failed sign-in attempts; try again later");
    }

    const user = await withTenant(deps.router, tenant, async (tx) => {
      const { rows } = await tx.query<{ id: string; password_hash: string; status: string }>(
        "SELECT id, password_hash, status FROM users WHERE email = $1",
        [body.email],
      );
      return rows[0];
    });
    const valid = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid || user.status !== "ACTIVE") {
      await deps.redis.multi().incr(failuresKey).expire(failuresKey, LOCKOUT_WINDOW_SECONDS).exec();
      if (user) {
        await withTenant(deps.router, tenant, (tx) =>
          recordAudit(tx, {
            tenantId: tenant.id,
            actorId: user.id,
            action: "auth.login_failed",
            resourceType: "user",
            resourceId: user.id,
            correlationId: req.id,
          }),
        );
      }
      throw unauthorized("invalid credentials");
    }

    await deps.redis.del(failuresKey);
    await withTenant(deps.router, tenant, (tx) =>
      recordAudit(tx, {
        tenantId: tenant.id,
        actorId: user.id,
        action: "auth.login",
        resourceType: "user",
        resourceId: user.id,
        correlationId: req.id,
      }),
    );
    return { ...(await deps.tokens.issue({ sub: user.id, tid: tenant.id })), tokenType: "Bearer" };
  });
}
