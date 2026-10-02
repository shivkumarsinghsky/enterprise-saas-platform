import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { registerAssetRoutes } from "../../modules/assets/routes.js";
import { registerAuditRoutes } from "../../modules/audit/routes.js";
import { registerIdentityRoutes } from "../../modules/identity/routes.js";
import { registerRoleRoutes } from "../../modules/rbac/routes.js";
import { limitOf } from "../../modules/tenancy/entitlements.js";
import { registerTenancyRoutes } from "../../modules/tenancy/routes.js";
import { registerUserRoutes } from "../../modules/users/routes.js";
import { AppError, unauthorized } from "../errors.js";
import type { AppDeps } from "./deps.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route handles its own authentication (login, platform operator API, health). */
    public?: boolean;
  }
}

/**
 * Request pipeline (the "gateway" concerns, applied uniformly):
 *   correlation id → authentication (JWT) → tenant context (status, entitlements, permissions)
 *   → per-tenant rate limit + usage metering → route guards (permission, feature) → handler.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    genReqId: (req) => {
      const header = req.headers["x-correlation-id"];
      return typeof header === "string" && /^[\w-]{1,100}$/.test(header) ? header : randomUUID();
    },
    bodyLimit: 1_048_576,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-correlation-id", req.id);
  });

  app.addHook("onResponse", async (req, reply) => {
    deps.metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.addHook("preHandler", async (req, reply) => {
    if (req.routeOptions.config.public || !req.routeOptions.url) return;
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const claims = await deps.tokens.verify(header.slice("Bearer ".length));
    const ctx = await deps.contexts.load(claims, req.id);
    req.tenantCtx = ctx;
    req.log = req.log.child({ tenantId: ctx.tenant.id, userId: ctx.userId });

    // Graceful degradation: if Redis is unavailable, serve the request (fail open) rather than fail it.
    const rl = await deps.rateLimiter
      .hit(ctx.tenant.id, limitOf(ctx.entitlements, "api-rate-limit") ?? null)
      .catch((err: unknown) => {
        req.log.warn({ err }, "rate limiter unavailable; allowing request");
        return null;
      });
    if (!rl) return;
    if (Number.isFinite(rl.limit)) {
      reply.header("x-ratelimit-limit", rl.limit);
      reply.header("x-ratelimit-remaining", rl.remaining);
    }
    if (!rl.allowed) {
      deps.metrics.rateLimited.inc();
      reply.header("retry-after", rl.resetSeconds);
      throw new AppError(429, "RATE_LIMITED", "tenant request rate limit exceeded");
    }
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, correlationId: req.id });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_FAILED",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        correlationId: req.id,
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: "BAD_REQUEST", message: (error as Error).message, correlationId: req.id });
    }
    req.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "INTERNAL", message: "internal error", correlationId: req.id });
  });

  app.get("/health/live", { config: { public: true } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { config: { public: true } }, async (_req, reply) => {
    const checks = {
      database: await deps.router.pooled
        .query("SELECT 1")
        .then(() => true)
        .catch(() => false),
      redis: await deps.redis
        .ping()
        .then((r) => r === "PONG")
        .catch(() => false),
    };
    const ready = checks.database && checks.redis;
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });
  app.get("/metrics", { config: { public: true } }, async (_req, reply) => {
    reply.header("content-type", deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  registerIdentityRoutes(app, deps);
  registerTenancyRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerRoleRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerAuditRoutes(app, deps);
  return app;
}
