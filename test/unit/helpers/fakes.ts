import { randomUUID } from 'node:crypto';
import type {
  BannerCache,
  LocalCache,
  SingleFlightCoordinator,
  SingleFlightLease,
} from '../../../src/modules/banners/application/banner-service.js';
import type { Banner } from '../../../src/modules/banners/domain/banner.js';
import type { BannerRepository } from '../../../src/modules/banners/domain/banner-repository.js';
import { RepositoryError } from '../../../src/shared/errors/application-error.js';

export function makeBanner(overrides: Partial<Banner> = {}): Banner {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'banner-1',
    title: 'Test Banner',
    imageUrl: 'https://cdn.example.com/test.png',
    targetUrl: 'https://example.com/test',
    priority: 1,
    isActive: true,
    startDate: null,
    endDate: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** Repository stub that counts calls and can simulate latency or failure. */
export class FakeRepository implements BannerRepository {
  public callCount = 0;
  public shouldFail = false;
  public delayMs = 0;

  public constructor(private banners: Banner[] = [makeBanner()]) {}

  public setBanners(banners: Banner[]): void {
    this.banners = banners;
  }

  public async findActive(_now: Date): Promise<Banner[]> {
    this.callCount += 1;
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.shouldFail) throw new RepositoryError('simulated database failure');
    return this.banners;
  }
}

/**
 * Shared state backing a "Redis instance". Multiple FakeBannerCache /
 * FakeSingleFlight objects can point at the same state to simulate several
 * API replicas talking to one Redis.
 */
export interface SharedRedisState {
  store: Map<string, string>;
  locks: Map<string, string>;
  waiters: Map<string, (() => void)[]>;
}

export function createSharedRedisState(): SharedRedisState {
  return { store: new Map(), locks: new Map(), waiters: new Map() };
}

/** In-memory stand-in for the Redis data cache, with failure injection. */
export class FakeBannerCache implements BannerCache {
  public getCalls = 0;
  public setCalls = 0;
  public shouldFailGet = false;
  public shouldFailSet = false;

  public constructor(public readonly state: SharedRedisState = createSharedRedisState()) {}

  /** Another client instance sharing this one's backing state. */
  public fork(): FakeBannerCache {
    return new FakeBannerCache(this.state);
  }

  public async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.shouldFailGet) throw new Error('simulated redis GET failure');
    return this.state.store.get(key) ?? null;
  }

  public async set(key: string, value: string, _ttlSeconds: number): Promise<void> {
    this.setCalls += 1;
    if (this.shouldFailSet) throw new Error('simulated redis SET failure');
    this.state.store.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.state.store.delete(key);
  }
}

/** In-memory stand-in for the Redis single-flight lease. */
export class FakeSingleFlight implements SingleFlightCoordinator {
  public shouldFailAcquire = false;
  public acquireCalls = 0;
  public waitCalls = 0;

  public constructor(
    public readonly state: SharedRedisState = createSharedRedisState(),
    private readonly waitTimeoutMs = 300,
  ) {}

  public fork(): FakeSingleFlight {
    return new FakeSingleFlight(this.state, this.waitTimeoutMs);
  }

  public async acquire(cacheKey: string): Promise<SingleFlightLease> {
    this.acquireCalls += 1;
    if (this.shouldFailAcquire) throw new Error('simulated redis connection failure');
    if (this.state.locks.has(cacheKey)) return { acquired: false };
    const token = randomUUID();
    this.state.locks.set(cacheKey, token);
    return { acquired: true, token };
  }

  public async release(cacheKey: string, token: string): Promise<void> {
    if (this.state.locks.get(cacheKey) === token) {
      this.state.locks.delete(cacheKey);
    }
    this.notify(cacheKey);
  }

  public async forceReleaseForTesting(cacheKey: string): Promise<void> {
    this.state.locks.delete(cacheKey);
    this.notify(cacheKey);
  }

  public async waitForLeader(cacheKey: string): Promise<void> {
    this.waitCalls += 1;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        removeWaiter();
        resolve();
      }, this.waitTimeoutMs);

      const waiter = (): void => {
        clearTimeout(timer);
        removeWaiter();
        resolve();
      };

      const list = this.state.waiters.get(cacheKey) ?? [];
      list.push(waiter);
      this.state.waiters.set(cacheKey, list);

      const removeWaiter = (): void => {
        const current = this.state.waiters.get(cacheKey) ?? [];
        this.state.waiters.set(
          cacheKey,
          current.filter((fn) => fn !== waiter),
        );
      };
    });
  }

  /** Test helper: release a lock without owning it (simulates TTL expiry). */
  public forceExpireLock(cacheKey: string): void {
    this.state.locks.delete(cacheKey);
  }

  /** Test helper: wake every waiter on a key. */
  public notify(cacheKey: string): void {
    for (const waiter of this.state.waiters.get(cacheKey) ?? []) waiter();
  }
}

/** Spy-capable local cache implementing the LocalCache port. */
export class FakeLocalCache<T> implements LocalCache<T> {
  private readonly store = new Map<string, T>();
  public getCalls = 0;
  public setCalls = 0;
  /** TTL passed on the most recent set(), so tests can assert which TTL is used. */
  public lastTtlMs: number | undefined;

  public get(key: string): T | undefined {
    this.getCalls += 1;
    return this.store.get(key);
  }

  public set(key: string, value: T, ttlMs?: number): void {
    this.setCalls += 1;
    this.lastTtlMs = ttlMs;
    this.store.set(key, value);
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
