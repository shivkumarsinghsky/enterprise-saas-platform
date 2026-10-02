import { loadConfig } from "./config.js";
import { TokenService } from "./modules/identity/tokens.js";
import { OutboxDispatcher } from "./modules/notifications/dispatcher.js";
import { ContextLoader } from "./modules/tenancy/context-loader.js";
import { TenantRateLimiter } from "./modules/usage/rate-limiter.js";
import { createPool, TenantRouter } from "./platform/db.js";
import { buildApp } from "./platform/http/app.js";
import { createLogger } from "./platform/logger.js";
import { createMetrics } from "./platform/metrics.js";
import { connectRedis } from "./platform/redis.js";

const config = loadConfig();
const log = createLogger(config.SERVICE_NAME, config.LOG_LEVEL);
const metrics = createMetrics(config.SERVICE_NAME);
const router = new TenantRouter(
  createPool(config.DATABASE_URL),
  new Map(Object.entries(config.DEDICATED_DATABASES).map(([k, url]) => [k, createPool(url)])),
);
const redis = await connectRedis(config.REDIS_URL);
const tokens = new TokenService({
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  privateKeyPem: config.JWT_PRIVATE_KEY,
});
if (tokens.usesEphemeralKey)
  log.warn("JWT_PRIVATE_KEY not set: using an ephemeral signing key (development only)");

const app = buildApp({
  router,
  redis,
  tokens,
  contexts: new ContextLoader(router),
  rateLimiter: new TenantRateLimiter(redis),
  metrics,
  log,
  platformApiKey: config.PLATFORM_API_KEY,
});

const dispatcher = config.roles.has("worker")
  ? new OutboxDispatcher(router, log, metrics, config.OUTBOX_POLL_INTERVAL_MS)
  : undefined;
dispatcher?.start();

// Workers still listen, so health checks and metrics work for every role.
await app.listen({ host: "0.0.0.0", port: config.HTTP_PORT });
log.info({ roles: [...config.roles], placements: router.placements() }, "saas platform started");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await app.close();
  await dispatcher?.stop();
  redis.disconnect();
  await router.end();
  process.exit(0);
};
process.once("SIGTERM", (s) => void shutdown(s));
process.once("SIGINT", (s) => void shutdown(s));
