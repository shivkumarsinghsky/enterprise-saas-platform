import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../platform/db.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { ctxOf, requireFeature, requirePermission } from "../../platform/http/guards.js";

const query = z.object({
  action: z.string().max(100).optional(),
  actor: z.string().max(100).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** id of the last event of the previous page (events are returned newest first) */
  before: z.coerce.number().int().positive().optional(),
});

export function registerAuditRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    "/audit-events",
    { preHandler: [requireFeature("audit-log"), requirePermission("audit:read")] },
    async (req) => {
      const q = query.parse(req.query);
      return withTenant(deps.router, ctxOf(req).tenant, async (tx) => {
        const { rows } = await tx.query(
          `SELECT id::int, actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId",
                  details, correlation_id AS "correlationId", occurred_at AS "occurredAt"
             FROM audit_events
            WHERE ($1::text IS NULL OR action = $1)
              AND ($2::text IS NULL OR actor_id = $2)
              AND ($3::timestamptz IS NULL OR occurred_at >= $3)
              AND ($4::timestamptz IS NULL OR occurred_at < $4)
              AND ($5::bigint IS NULL OR id < $5)
            ORDER BY id DESC
            LIMIT $6`,
          [q.action ?? null, q.actor ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit],
        );
        return { items: rows, nextBefore: rows.length === q.limit ? rows.at(-1)?.id : null };
      });
    },
  );
}
