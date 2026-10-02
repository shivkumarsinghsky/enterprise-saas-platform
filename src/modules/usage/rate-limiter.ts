import type { Redis } from "ioredis";
import { tenantKey } from "../../platform/cache.js";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Per-tenant fixed-window rate limiter in Redis. The limit comes from the tenant's plan (`api-rate-limit`), so
 * one tenant's burst cannot consume the shared capacity of others (noisy-neighbour protection).
 * The same pipeline increments a daily usage counter used for metering.
 */
export class TenantRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(tenantId: string, limitPerMinute: number | null): Promise<RateLimitResult> {
    const nowMs = this.now();
    const window = Math.floor(nowMs / 60_000);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const rlKey = tenantKey(tenantId, "rl", String(window));
    const usageKey = tenantKey(tenantId, "usage", day);
    const results = await this.redis
      .multi()
      .incr(rlKey)
      .expire(rlKey, 61)
      .incr(usageKey)
      .expire(usageKey, 40 * 24 * 3600)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const resetSeconds = 60 - Math.floor((nowMs % 60_000) / 1000);
    if (limitPerMinute === null) return { allowed: true, limit: Infinity, remaining: Infinity, resetSeconds };
    return {
      allowed: count <= limitPerMinute,
      limit: limitPerMinute,
      remaining: Math.max(0, limitPerMinute - count),
      resetSeconds,
    };
  }

  async usage(tenantId: string, days: number): Promise<{ date: string; requests: number }[]> {
    const dates = Array.from({ length: days }, (_, i) =>
      new Date(this.now() - i * 86_400_000).toISOString().slice(0, 10),
    );
    const values = await this.redis.mget(dates.map((d) => tenantKey(tenantId, "usage", d)));
    return dates.map((date, i) => ({ date, requests: Number(values[i] ?? 0) }));
  }
}
