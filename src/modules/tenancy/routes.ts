import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { withControlPlane, withTenant } from "../../platform/db.js";
import { notFound, unauthorized } from "../../platform/errors.js";
import type { AppDeps } from "../../platform/http/deps.js";
import { ctxOf, requirePermission } from "../../platform/http/guards.js";
import { recordAudit } from "../audit/audit.js";
import { FEATURES } from "./entitlements.js";
import { createTenantRequest, provisionTenant } from "./provisioning.js";
import { tenantRepository } from "./repository.js";

const settingsSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    branding: z
      .object({ primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
      .partial()
      .optional(),
  })
  .strict();

function assertPlatformOperator(req: FastifyRequest, apiKey: string) {
  const provided = Buffer.from(String(req.headers["x-platform-api-key"] ?? ""));
  const expected = Buffer.from(apiKey);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw unauthorized("platform operator credential required");
  }
}

export function registerTenancyRoutes(app: FastifyInstance, deps: AppDeps): void {
  // ---- Platform operator surface: separate credential, operates across tenants --------------------------
  app.register(async (platform) => {
    platform.addHook("onRequest", async (req) => assertPlatformOperator(req, deps.platformApiKey));

    platform.post("/platform/tenants", { config: { public: true } }, async (req, reply) => {
      const body = createTenantRequest.parse(req.body);
      const result = await provisionTenant(deps.router, body, req.id);
      return reply.code(201).send(result);
    });

    platform.get("/platform/tenants", { config: { public: true } }, async () =>
      withControlPlane(deps.router, (tx) => tenantRepository.list(tx)),
    );

    platform.patch<{ Params: { id: string } }>(
      "/platform/tenants/:id",
      { config: { public: true } },
      async (req) => {
        const patch = z
          .object({ status: z.enum(["ACTIVE", "SUSPENDED"]).optional(), plan: z.string().optional() })
          .strict()
          .parse(req.body);
        const tenant = await withControlPlane(deps.router, async (tx) => {
          if (!(await tenantRepository.byId(tx, req.params.id))) throw notFound("tenant");
          await tenantRepository.update(tx, req.params.id, { status: patch.status, planId: patch.plan });
          return tenantRepository.byId(tx, req.params.id);
        });
        deps.contexts.invalidateTenant(req.params.id);
        return tenant;
      },
    );

    platform.put<{ Params: { id: string; feature: string } }>(
      "/platform/tenants/:id/features/:feature",
      { config: { public: true } },
      async (req) => {
        const feature = z.enum(FEATURES).parse(req.params.feature);
        const body = z
          .object({ enabled: z.boolean(), limit: z.number().int().positive().nullable().default(null) })
          .parse(req.body);
        await withControlPlane(deps.router, (tx) =>
          tenantRepository.setOverride(tx, req.params.id, {
            featureKey: feature,
            enabled: body.enabled,
            limitValue: body.limit,
          }),
        );
        deps.contexts.invalidateTenant(req.params.id);
        return { tenantId: req.params.id, feature, ...body };
      },
    );
  });

  // ---- Tenant surface: tenant always comes from the verified token -------------------------------------
  app.get("/me", async (req) => {
    const ctx = ctxOf(req);
    return {
      userId: ctx.userId,
      tenant: { id: ctx.tenant.id, slug: ctx.tenant.slug, name: ctx.tenant.name, plan: ctx.tenant.planId },
      permissions: [...ctx.permissions].sort(),
      features: Object.keys(ctx.entitlements.features).sort(),
    };
  });

  app.get("/tenant/entitlements", async (req) => ctxOf(req).entitlements);

  app.get(
    "/tenant/settings",
    { preHandler: requirePermission("settings:read") },
    async (req) => ctxOf(req).tenant.settings,
  );

  app.patch("/tenant/settings", { preHandler: requirePermission("settings:write") }, async (req) => {
    const ctx = ctxOf(req);
    const settings = { ...ctx.tenant.settings, ...settingsSchema.parse(req.body) };
    await withControlPlane(deps.router, (tx) => tenantRepository.update(tx, ctx.tenant.id, { settings }));
    await withTenant(deps.router, ctx.tenant, (tx) =>
      recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorId: ctx.userId,
        action: "tenant.settings_updated",
        resourceType: "tenant",
        resourceId: ctx.tenant.id,
        details: { settings },
        correlationId: ctx.correlationId,
      }),
    );
    deps.contexts.invalidateTenant(ctx.tenant.id);
    return settings;
  });

  app.get("/tenant/usage", { preHandler: requirePermission("usage:read") }, async (req) => ({
    daily: await deps.rateLimiter.usage(ctxOf(req).tenant.id, 7),
  }));
}
