import type { Redis } from "ioredis";
import type { TokenService } from "../../modules/identity/tokens.js";
import type { ContextLoader } from "../../modules/tenancy/context-loader.js";
import type { TenantRateLimiter } from "../../modules/usage/rate-limiter.js";
import type { TenantRouter } from "../db.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";

export interface AppDeps {
  router: TenantRouter;
  redis: Redis;
  tokens: TokenService;
  contexts: ContextLoader;
  rateLimiter: TenantRateLimiter;
  metrics: Metrics;
  log: Logger;
  platformApiKey: string;
}
