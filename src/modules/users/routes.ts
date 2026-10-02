import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../platform/db.js";
import { AppError, conflict, forbidden, notFound } from "../../platform/errors.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { ctxOf, requirePermission } from "../../platform/http/guards.js";
import { hashPassword } from "../../platform/passwords.js";
import { recordAudit } from "../audit/audit.js";
import { enqueueEvent } from "../notifications/outbox.js";
import { limitOf } from "../tenancy/entitlements.js";

const createUserRequest = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  displayName: z.string().min(1).max(200),
  /** Initial password; a production system would send an invitation link instead. */
  password: z.string().min(12).max(200),
  roles: z.array(z.string().min(1)).min(1).max(20),
});

const assignRolesRequest = z.object({ roles: z.array(z.string().min(1)).min(1).max(20) });
const updateUserRequest = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).strict();

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/users", { preHandler: requirePermission("users:read") }, async (req) => {
    const ctx = ctxOf(req);
    return withTenant(deps.router, ctx.tenant, async (tx) => {
      // No tenant filter in the SQL on purpose: row-level security scopes the result to the current tenant.
      const { rows } = await tx.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.status,
                COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
          GROUP BY u.id ORDER BY u.email`,
      );
      return rows;
    });
  });

  app.post("/users", { preHandler: requirePermission("users:write") }, async (req, reply) => {
    const ctx = ctxOf(req);
    const body = createUserRequest.parse(req.body);
    const maxUsers = limitOf(ctx.entitlements, "max-users");
    const passwordHash = await hashPassword(body.password);

    const user = await withTenant(deps.router, ctx.tenant, async (tx) => {
      // Serialise user creation per tenant so two concurrent requests cannot both pass the plan limit.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`users:${ctx.tenant.id}`]);
      if (maxUsers !== null && maxUsers !== undefined) {
        const { rows } = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'",
        );
        if (rows[0]!.n >= maxUsers) {
          throw new AppError(
            402,
            "PLAN_LIMIT_REACHED",
            `the ${ctx.tenant.planId} plan allows ${maxUsers} active users`,
          );
        }
      }
      const roles = await tx.query<{ id: string; name: string }>(
        "SELECT id, name FROM roles WHERE name = ANY($1)",
        [body.roles],
      );
      if (roles.rowCount !== body.roles.length)
        throw new AppError(400, "UNKNOWN_ROLE", "one or more roles do not exist");
      const id = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO users (id, tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, email) DO NOTHING`,
        [id, ctx.tenant.id, body.email, body.displayName, passwordHash],
      );
      if (inserted.rowCount === 0) throw conflict("a user with this email already exists");
      for (const role of roles.rows) {
        await tx.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
          ctx.tenant.id,
          id,
          role.id,
        ]);
      }
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorId: ctx.userId,
        action: "user.created",
        resourceType: "user",
        resourceId: id,
        details: { email: body.email, roles: body.roles },
        correlationId: ctx.correlationId,
      });
      await enqueueEvent(
        tx,
        ctx.tenant.id,
        { type: "UserInvited", payload: { userId: id, email: body.email, displayName: body.displayName } },
        ctx.correlationId,
      );
      return {
        id,
        email: body.email,
        displayName: body.displayName,
        status: "ACTIVE",
        roles: body.roles.sort(),
      };
    });
    return reply.code(201).send(user);
  });

  app.put<{ Params: { id: string } }>(
    "/users/:id/roles",
    { preHandler: requirePermission("users:write") },
    async (req) => {
      const ctx = ctxOf(req);
      const body = assignRolesRequest.parse(req.body);
      const result = await withTenant(deps.router, ctx.tenant, async (tx) => {
        const user = await tx.query("SELECT 1 FROM users WHERE id = $1", [req.params.id]);
        if (!user.rowCount) throw notFound("user"); // also the answer for another tenant's user id
        const roles = await tx.query<{ id: string; name: string }>(
          "SELECT id, name FROM roles WHERE name = ANY($1)",
          [body.roles],
        );
        if (roles.rowCount !== body.roles.length)
          throw new AppError(400, "UNKNOWN_ROLE", "one or more roles do not exist");
        await tx.query("DELETE FROM user_roles WHERE user_id = $1", [req.params.id]);
        for (const role of roles.rows) {
          await tx.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
            ctx.tenant.id,
            req.params.id,
            role.id,
          ]);
        }
        await assertAdminRemains(tx);
        await recordAudit(tx, {
          tenantId: ctx.tenant.id,
          actorId: ctx.userId,
          action: "user.roles_changed",
          resourceType: "user",
          resourceId: req.params.id,
          details: { roles: body.roles },
          correlationId: ctx.correlationId,
        });
        return { id: req.params.id, roles: body.roles.sort() };
      });
      deps.contexts.invalidateUser(ctx.tenant.id, req.params.id);
      return result;
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/users/:id",
    { preHandler: requirePermission("users:write") },
    async (req) => {
      const ctx = ctxOf(req);
      const body = updateUserRequest.parse(req.body);
      await withTenant(deps.router, ctx.tenant, async (tx) => {
        const updated = await tx.query("UPDATE users SET status = $2 WHERE id = $1", [
          req.params.id,
          body.status,
        ]);
        if (!updated.rowCount) throw notFound("user");
        await assertAdminRemains(tx);
        await recordAudit(tx, {
          tenantId: ctx.tenant.id,
          actorId: ctx.userId,
          action: body.status === "DISABLED" ? "user.disabled" : "user.enabled",
          resourceType: "user",
          resourceId: req.params.id,
          correlationId: ctx.correlationId,
        });
      });
      deps.contexts.invalidateUser(ctx.tenant.id, req.params.id);
      return { id: req.params.id, status: body.status };
    },
  );
}

/** A tenant must never lock itself out: at least one active tenant-admin must remain. */
async function assertAdminRemains(tx: import("../../platform/db.js").Tx): Promise<void> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'tenant-admin' AND u.status = 'ACTIVE'`,
  );
  if (rows[0]!.n === 0) throw forbidden("LAST_ADMIN", "at least one active tenant-admin is required");
}
