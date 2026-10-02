import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../platform/db.js";
import { AppError, conflict, notFound } from "../../platform/errors.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { ctxOf, requireFeature, requirePermission } from "../../platform/http/guards.js";
import { recordAudit } from "../audit/audit.js";

/**
 * Example business module (an asset register, as in Enterprise Asset Management). It contains no tenant
 * logic beyond using the request's tenant context: isolation is provided by the platform.
 */
const createAssetRequest = z.object({
  tag: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, "uppercase tag such as PUMP-101"),
  name: z.string().min(1).max(200),
  location: z.string().max(200).optional(),
});

const listQuery = z.object({
  status: z.enum(["IN_SERVICE", "OUT_OF_SERVICE", "RETIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque keyset cursor: base64url("<createdAt>|<id>") of the last item of the previous page. */
  cursor: z.string().optional(),
});

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError(400, "INVALID_CURSOR", "invalid cursor");
  return [ts, id];
}

export function registerAssetRoutes(app: FastifyInstance, deps: AppDeps): void {
  const read = [requireFeature("assets"), requirePermission("assets:read")];
  const write = [requireFeature("assets"), requirePermission("assets:write")];

  app.get("/assets", { preHandler: read }, async (req) => {
    const q = listQuery.parse(req.query);
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    return withTenant(deps.router, ctxOf(req).tenant, async (tx) => {
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `SELECT id, tag, name, location, status, created_at FROM assets
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [q.status ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(({ created_at, ...rest }) => ({ ...rest, createdAt: created_at.toISOString() })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/assets/:id", { preHandler: read }, async (req) => {
    const id = z.uuid().parse(req.params.id);
    const asset = await withTenant(deps.router, ctxOf(req).tenant, async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, tag, name, location, status, created_at AS "createdAt" FROM assets WHERE id = $1',
        [id],
      );
      return rows[0];
    });
    if (!asset) throw notFound("asset"); // another tenant's asset is indistinguishable from a missing one
    return asset;
  });

  app.post("/assets", { preHandler: write }, async (req, reply) => {
    const ctx = ctxOf(req);
    const body = createAssetRequest.parse(req.body);
    const asset = await withTenant(deps.router, ctx.tenant, async (tx) => {
      const id = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO assets (id, tenant_id, tag, name, location, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, tag) DO NOTHING`,
        [id, ctx.tenant.id, body.tag, body.name, body.location ?? null, ctx.userId],
      );
      if (!inserted.rowCount) throw conflict(`asset tag ${body.tag} already exists`);
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorId: ctx.userId,
        action: "asset.created",
        resourceType: "asset",
        resourceId: id,
        details: { tag: body.tag },
        correlationId: ctx.correlationId,
      });
      return { id, ...body, status: "IN_SERVICE" };
    });
    return reply.code(201).send(asset);
  });
}
