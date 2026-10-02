import pg from "pg";
import { TokenService } from "../../src/modules/identity/tokens.js";
import { OutboxDispatcher } from "../../src/modules/notifications/dispatcher.js";
import { ContextLoader } from "../../src/modules/tenancy/context-loader.js";
import { TenantRateLimiter } from "../../src/modules/usage/rate-limiter.js";
import { createPool, TenantRouter } from "../../src/platform/db.js";
import { buildApp } from "../../src/platform/http/app.js";
import { createLogger } from "../../src/platform/logger.js";
import { createMetrics } from "../../src/platform/metrics.js";
import { connectRedis } from "../../src/platform/redis.js";
import { migrate } from "../../scripts/migrate.js";

/**
 * Integration tests need a PostgreSQL superuser URL (to create test databases and the app role) and Redis:
 *   TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 *   TEST_REDIS_URL=redis://localhost:6379/15
 */
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
export const REDIS_URL = process.env.TEST_REDIS_URL;
export const integrationEnabled = Boolean(ADMIN_URL && REDIS_URL);

export const PLATFORM_KEY = "test-platform-operator-key-0123456789";
const APP_PASSWORD = "saas-app-test-password";
const DBS = { pooled: "saas_it_pooled", dedicated: "saas_it_dedicated" };

const urlFor = (db: string, user?: { name: string; password: string }) => {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

export async function startTestPlatform() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const db of Object.values(DBS)) {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();
  const silent = () => {};
  for (const db of Object.values(DBS)) await migrate(urlFor(db), APP_PASSWORD, silent);

  const appUser = { name: "saas_app", password: APP_PASSWORD };
  const router = new TenantRouter(
    createPool(urlFor(DBS.pooled, appUser)),
    new Map([["dedicated-eu-1", createPool(urlFor(DBS.dedicated, appUser))]]),
  );
  const redis = await connectRedis(REDIS_URL!);
  await redis.flushdb();
  const log = createLogger("saas-it", process.env.TEST_LOG_LEVEL ?? "silent");
  const metrics = createMetrics("saas-it");
  const contexts = new ContextLoader(router);
  const app = buildApp({
    router,
    redis,
    tokens: new TokenService({ issuer: "https://saas.test/", audience: "saas-api", ttlSeconds: 300 }),
    contexts,
    rateLimiter: new TenantRateLimiter(redis),
    metrics,
    log,
    platformApiKey: PLATFORM_KEY,
  });
  await app.ready();
  const dispatcher = new OutboxDispatcher(router, log, metrics, 1_000);

  /** Superuser connections, used only by tests to inspect where data physically landed. */
  const inspect = {
    pooled: new pg.Pool({ connectionString: urlFor(DBS.pooled) }),
    dedicated: new pg.Pool({ connectionString: urlFor(DBS.dedicated) }),
  };
  /** Raw app-role connection to probe RLS directly. */
  const appRole = new pg.Pool({ connectionString: urlFor(DBS.pooled, appUser) });

  return {
    app,
    router,
    redis,
    dispatcher,
    inspect,
    appRole,
    async stop() {
      await app.close();
      redis.disconnect();
      await router.end();
      await inspect.pooled.end();
      await inspect.dedicated.end();
      await appRole.end();
    },
  };
}
