import { LRUCache } from 'lru-cache';
import type { LocalCache } from '../../application/banner-service.js';

/**
 * Layer 2 adapter: per-instance, bounded LRU/TTL cache.
 *
 * Intentionally NOT shared across instances — each API process holds its own
 * copy, checked after the CDN and before Redis. Keep the TTL short: this
 * cache trades a small inter-instance consistency window for zero-network-hop
 * hits, and the bound stops a hot key set from growing memory without limit.
 */
export class InMemoryBannerCache<T extends object> implements LocalCache<T> {
  private readonly store: LRUCache<string, T>;

  public constructor(maxItems: number, defaultTtlMs: number) {
    this.store = new LRUCache<string, T>({
      max: maxItems,
      ttl: defaultTtlMs,
      // Enforce TTL on read rather than relying solely on background purge,
      // so a get() after expiry reliably reports a miss instead of a stale hit.
      ttlAutopurge: false,
      updateAgeOnGet: false,
    });
  }

  public get(key: string): T | undefined {
    return this.store.get(key);
  }

  public set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, value, ttlMs ? { ttl: ttlMs } : undefined);
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}
