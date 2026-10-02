import { Redis } from "ioredis";

/**
 * Commands fail fast while disconnected (no offline queue) so a Redis outage surfaces immediately; callers
 * decide whether to degrade (the rate limiter fails open) or fail.
 */
export async function connectRedis(url: string): Promise<Redis> {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  await redis.connect();
  return redis;
}

export type { Redis };
