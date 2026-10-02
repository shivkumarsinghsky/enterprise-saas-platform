import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../platform/db.js";
import { conflict } from "../../platform/errors.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { ctxOf, requireFeature, requirePermission } from "../../platform/http/guards.js";
import { recordAudit } from "../audit/audit.js";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions.js";

const createRoleRequest = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,40}$/)
    .refine((n) => !(n in SYSTEM_ROLES), "system role names are reserved"),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
});

export function registerRoleRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/roles", { preHandler: requirePermission("roles:read") }, async (req) =>
    withTenant(deps.router, ctxOf(req).tenant, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, name, permissions, is_system AS "isSystem" FROM roles ORDER BY is_system DESC, name`,
      );
      return rows;
    }),
  );

  app.get("/permissions", { preHandler: requirePermission("roles:read") }, async () => PERMISSIONS);

  app.post(
    "/roles",
    { preHandler: [requirePermission("roles:write"), requireFeature("custom-roles")] },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const body = createRoleRequest.parse(req.body);
      const role = await withTenant(deps.router, ctx.tenant, async (tx) => {
        const id = randomUUID();
        const inserted = await tx.query(
          `INSERT INTO roles (id, tenant_id, name, permissions) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, name) DO NOTHING`,
          [id, ctx.tenant.id, body.name, [...new Set(body.permissions)]],
        );
        if (!inserted.rowCount) throw conflict(`role '${body.name}' already exists`);
        await recordAudit(tx, {
          tenantId: ctx.tenant.id,
          actorId: ctx.userId,
          action: "role.created",
          resourceType: "role",
          resourceId: id,
          details: { name: body.name, permissions: body.permissions },
          correlationId: ctx.correlationId,
        });
        return { id, name: body.name, permissions: [...new Set(body.permissions)], isSystem: false };
      });
      return reply.code(201).send(role);
    },
  );
}
