import type { Redis } from 'ioredis';
import type { BannerCache } from '../../application/banner-service.js';

/**
 * Layer 3 adapter: shared Redis cache.
 *
 * Deliberately thin — it does no error swallowing. Failures propagate to
 * BannerService, which owns the fail-open decision and circuit-breaker
 * bookkeeping. Keeping that policy in one place makes the resilience
 * behavior testable without a real Redis.
 */
export class RedisBannerCache implements BannerCache {
  public constructor(private readonly redis: Redis) {}

  public async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  public async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
