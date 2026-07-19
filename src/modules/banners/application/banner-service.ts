import type { Banner } from '../domain/banner.js';
import type { BannerRepository } from '../domain/banner-repository.js';
import { RepositoryError } from '../../../shared/errors/application-error.js';
import type { Logger } from '../../../shared/observability/logger.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import type { CircuitBreaker } from '../../../shared/resilience/circuit-breaker.js';
import { ACTIVE_BANNERS_CACHE_KEY } from './banner-cache-keys.js';

/*
 * ---------------------------------------------------------------------------
 * Outbound ports
 * ---------------------------------------------------------------------------
 * Defined here, in the layer that consumes them (ports-and-adapters idiom).
 * Concrete Redis / LRU implementations live in `infrastructure/cache` and
 * depend inward on these interfaces — never the other way around.
 */

/** Shared, cross-instance cache (Redis in production). */
export interface BannerCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Bounded per-instance cache (LRU + TTL). Synchronous: no network hop. */
export interface LocalCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
}

export interface SingleFlightLease {
  /** True if this instance won the lease and must load + populate the cache. */
  acquired: boolean;
  /** Opaque token required for a token-safe release. Present iff acquired. */
  token?: string;
}

/** Cross-instance single-flight coordination (Redis lease in production). */
export interface SingleFlightCoordinator {
  acquire(cacheKey: string): Promise<SingleFlightLease>;
  release(cacheKey: string, token: string): Promise<void>;
  waitForLeader(cacheKey: string): Promise<void>;
  /**
   * Test-only: unconditionally clears the lock for `cacheKey`, regardless of
   * which token (if any) currently holds it. Production code never calls
   * this — a stale lock is left to expire on its own TTL, since force-clearing
   * it could let two replicas believe they are simultaneously the leader.
   * Safe here only because it is reachable exclusively through the
   * test-controls route, which does not exist unless explicitly enabled.
   */
  forceReleaseForTesting(cacheKey: string): Promise<void>;
}

/* ------------------------------------------------------------------------- */

/** Which layer ultimately served the response. */
export type CacheLayer = 'in-memory' | 'redis' | 'database';

/**
 * Outcome of a single getActiveBanners() call, used for response headers,
 * logging, and test assertions that prove which path was taken.
 *
 * `wasLeaseHolder` / `wasLeaseWaiter` describe the CROSS-INSTANCE (Redis)
 * lease role only. A request that won the LOCAL in-flight promise race (i.e.
 * collapsed other same-instance callers behind it) is not necessarily the
 * cross-instance lease holder — it may itself have lost the Redis lease and
 * waited for another replica, in which case it is a lease *waiter* whose
 * `servedBy` is `'redis'`, not `'database'`. See `ResolutionOutcome` for the
 * richer internal type that keeps these roles separate.
 */
export interface RequestOutcome {
  banners: Banner[];
  servedBy: CacheLayer;
  wasLeaseHolder: boolean;
  wasLeaseWaiter: boolean;
}

/**
 * Internal resolution outcome for a database-or-lease resolution, once the
 * in-memory and Redis cache-aside reads have both missed. Richer than a bare
 * `Promise<Banner[]>` so that a local in-flight *waiter* — who awaits this
 * same promise on this instance — can report the same accurate role/served-by
 * information as the local leader who produced it, instead of the waiter's
 * caller having to guess.
 */
export interface ResolutionOutcome {
  banners: Banner[];
  /** Layer that actually supplied the payload. */
  servedBy: CacheLayer;
  /**
   * Cross-instance (Redis) lease role for the call that produced this
   * outcome. `'leader'` acquired the lease and queried the database (or
   * failed open to the database without coordination). `'waiter'` lost the
   * lease and is relaying another replica's Redis-filled result.
   */
  leaseRole: 'leader' | 'waiter';
  /** True only if THIS instance issued a `repository.findActive()` call to produce this outcome. */
  databaseQueried: boolean;
}

/** The cache stores domain banners; adapters own the serialized representation. */
export interface CachedBannerPayload {
  banners: Banner[];
}

export interface BannerServiceOptions {
  /** TTL for the shared Redis entry (Layer 3). */
  cacheTtlSeconds: number;
  /**
   * TTL for the per-instance in-memory entry (Layer 2).
   *
   * Deliberately separate from — and much shorter than — the Redis TTL. This
   * cache is not shared between replicas, so its TTL is the upper bound on
   * how long two replicas can disagree after an invalidation. Reusing the
   * Redis TTL here would widen that window to no benefit.
   */
  localCacheTtlMs: number;
}

export interface BannerServiceDependencies {
  repository: BannerRepository;
  cache: BannerCache;
  localCache: LocalCache<CachedBannerPayload>;
  singleFlight: SingleFlightCoordinator;
  circuitBreaker: CircuitBreaker;
  logger: Logger;
  options: BannerServiceOptions;
  metrics?: Metrics;
}

/**
 * Orchestrates the three-level cache-aside read path plus two layers of
 * request collapsing:
 *
 *   in-memory (L2) -> Redis (L3) -> [local memo] -> [Redis lease] -> database
 *
 * Every dependency is an injected port. This class has no knowledge of
 * MongoDB, ioredis, Fastify, or any ODM.
 */
export class BannerService {
  private readonly inFlight = new Map<string, Promise<ResolutionOutcome>>();

  /**
   * Monotonic invalidation generation, bumped by every `invalidate()` call.
   *
   * Guards against a specific race: a database load that started BEFORE an
   * invalidation (e.g. a slow leader mid-`loadFromRepository`) must not be
   * allowed to overwrite the caches AFTER that invalidation completes with
   * data that is now known stale. `resolveViaLeaseOrDatabase` captures the
   * epoch before starting the load; `populateCaches` only writes if the
   * epoch is still current. If it has moved on, the fill is dropped — the
   * next reader gets a clean cache miss and reloads, rather than silently
   * resurrecting pre-invalidation data. Cross-process ordering is handled
   * by the Redis lease while it is valid. A production-grade global version
   * check is deliberately not claimed by this prototype: it would require a
   * separate, atomically incremented invalidation generation that also covers
   * deletions, not merely the timestamps of the currently returned banners.
   */
  private invalidationEpoch = 0;

  private readonly repository: BannerRepository;
  private readonly cache: BannerCache;
  private readonly localCache: LocalCache<CachedBannerPayload>;
  private readonly singleFlight: SingleFlightCoordinator;
  private readonly circuit: CircuitBreaker;
  private readonly logger: Logger;
  private readonly options: BannerServiceOptions;
  // Declared as `| undefined` rather than optional: `exactOptionalPropertyTypes`
  // forbids assigning a possibly-undefined value to an optional property.
  private readonly metrics: Metrics | undefined;

  public constructor(dependencies: BannerServiceDependencies) {
    this.repository = dependencies.repository;
    this.cache = dependencies.cache;
    this.localCache = dependencies.localCache;
    this.singleFlight = dependencies.singleFlight;
    this.circuit = dependencies.circuitBreaker;
    this.logger = dependencies.logger;
    this.options = dependencies.options;
    this.metrics = dependencies.metrics;
  }

  public async getActiveBanners(now = new Date()): Promise<RequestOutcome> {
    // Layer 2: per-instance in-memory cache.
    const localHit = this.localCache.get(ACTIVE_BANNERS_CACHE_KEY);
    if (localHit) {
      this.metrics?.cacheEventsTotal.inc({ layer: 'in-memory', event: 'hit' });
      return {
        banners: localHit.banners,
        servedBy: 'in-memory',
        wasLeaseHolder: false,
        wasLeaseWaiter: false,
      };
    }
    this.metrics?.cacheEventsTotal.inc({ layer: 'in-memory', event: 'miss' });

    // Layer 3: Redis (cache-aside, fail-open on error, circuit-breaker guarded).
    const sharedHit = await this.readSharedCache();
    if (sharedHit) {
      this.localCache.set(ACTIVE_BANNERS_CACHE_KEY, sharedHit, this.options.localCacheTtlMs);
      this.metrics?.cacheEventsTotal.inc({ layer: 'redis', event: 'hit' });
      return {
        banners: sharedHit.banners,
        servedBy: 'redis',
        wasLeaseHolder: false,
        wasLeaseWaiter: false,
      };
    }

    // Both caches missed (or Redis is unavailable). Collapse concurrent
    // same-key requests on THIS instance behind a single in-flight promise.
    //
    // NOTE: "local leader" (won the in-process promise race) and "local
    // waiter" (awaited someone else's in-flight promise on this instance)
    // are ORTHOGONAL to the cross-instance lease role carried inside the
    // resolved `ResolutionOutcome`. A local leader can still be a
    // cross-instance lease *waiter* if another replica held the Redis lease;
    // in that case `servedBy` is `'redis'`, not `'database'`, and
    // `wasLeaseHolder`/`wasLeaseWaiter` on the public outcome must reflect
    // the cross-instance role that actually produced the data, not which
    // side of the local promise race this caller landed on.
    const existing = this.inFlight.get(ACTIVE_BANNERS_CACHE_KEY);
    if (existing) {
      this.metrics?.collapsingEventsTotal.inc({ scope: 'local', role: 'waiter' });
      const resolved = await existing;
      return toRequestOutcome(resolved);
    }

    this.metrics?.collapsingEventsTotal.inc({ scope: 'local', role: 'leader' });
    const operation = this.resolveViaLeaseOrDatabase(now).finally(() => {
      this.inFlight.delete(ACTIVE_BANNERS_CACHE_KEY);
    });
    this.inFlight.set(ACTIVE_BANNERS_CACHE_KEY, operation);
    const resolved = await operation;
    return toRequestOutcome(resolved);
  }

  /**
   * Cross-instance single-flight: when Redis coordination is available,
   * exactly one replica queries the database per cache key; the others wait
   * for the ready notification and re-read Redis. If Redis or the circuit is
   * down, coordination is skipped and we query the database directly
   * (fail-open).
   *
   * `servedBy` on the returned value reflects where the banners actually
   * came from — 'redis' for a cross-instance waiter that got fresh data from
   * the leader's cache fill without ever touching the database, 'database'
   * for the leader (or anyone who fails open). `leaseRole` and
   * `databaseQueried` carry that same distinction explicitly so callers
   * (including a local in-flight waiter relaying this same outcome) never
   * have to re-derive it from `servedBy`. This is what lets `X-Served-By`
   * prove, from outside the process, that a non-leader replica never queried
   * MongoDB.
   */
  private async resolveViaLeaseOrDatabase(now: Date): Promise<ResolutionOutcome> {
    if (this.circuit.isOpen()) {
      const banners = await this.loadFromRepository(now);
      return { banners, servedBy: 'database', leaseRole: 'leader', databaseQueried: true };
    }

    let lease: SingleFlightLease;
    try {
      lease = await this.singleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);
    } catch (error) {
      // The lease machinery itself failed: fail open, no coordination. This
      // instance never became a lease holder — it simply couldn't
      // coordinate — but it did query the database, so `databaseQueried`
      // must still be true even though `leaseRole` is nominally 'leader'
      // (there was no lease to hold).
      this.logger.warn({ err: error }, 'Lease acquisition failed; proceeding without coordination');
      const banners = await this.loadFromRepository(now);
      return { banners, servedBy: 'database', leaseRole: 'leader', databaseQueried: true };
    }

    if (!lease.acquired || !lease.token) {
      // Another instance is the leader: wait, then re-read Redis.
      this.metrics?.collapsingEventsTotal.inc({ scope: 'cross-instance', role: 'waiter' });
      try {
        await this.singleFlight.waitForLeader(ACTIVE_BANNERS_CACHE_KEY);
        const afterWait = await this.readSharedCache();
        if (afterWait) {
          return {
            banners: afterWait.banners,
            servedBy: 'redis',
            leaseRole: 'waiter',
            databaseQueried: false,
          };
        }
      } catch (error) {
        this.logger.warn({ err: error }, 'Lease wait failed; falling back to database');
      }
      // Notification/poll timed out without fresh data: fail open to the
      // database rather than blocking the request indefinitely. This
      // instance still queries the database itself here, so it must be
      // reported as having done so — `X-Served-By: database` is correct in
      // this specific branch, unlike the redis-relay branch above.
      const banners = await this.loadFromRepository(now);
      return { banners, servedBy: 'database', leaseRole: 'waiter', databaseQueried: true };
    }

    const token = lease.token;
    this.metrics?.collapsingEventsTotal.inc({ scope: 'cross-instance', role: 'leader' });
    try {
      const epochAtStart = this.invalidationEpoch;
      const banners = await this.loadFromRepository(now);
      await this.populateCaches(banners, epochAtStart);
      return { banners, servedBy: 'database', leaseRole: 'leader', databaseQueried: true };
    } finally {
      await this.singleFlight.release(ACTIVE_BANNERS_CACHE_KEY, token).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Failed to release lease');
      });
    }
  }

  private async readSharedCache(): Promise<CachedBannerPayload | null> {
    if (this.circuit.isOpen()) return null;
    try {
      const raw = await this.cache.get(ACTIVE_BANNERS_CACHE_KEY);
      this.circuit.recordSuccess();
      this.metrics?.recordCircuitState(this.circuit.getState());
      if (!raw) {
        this.metrics?.cacheEventsTotal.inc({ layer: 'redis', event: 'miss' });
        return null;
      }
      return deserializePayload(raw);
    } catch (error) {
      this.recordCacheFailure(error, 'Redis GET failed; falling back');
      this.metrics?.cacheEventsTotal.inc({ layer: 'redis', event: 'error' });
      return null;
    }
  }

  private async loadFromRepository(now: Date): Promise<Banner[]> {
    const start = process.hrtime.bigint();
    try {
      const banners = await this.repository.findActive(now);
      this.metrics?.dbQueriesTotal.inc({ outcome: 'success' });
      return banners;
    } catch (error) {
      this.metrics?.dbQueriesTotal.inc({ outcome: 'error' });
      this.logger.error({ err: error }, 'Database query failed');
      throw error instanceof RepositoryError
        ? error
        : new RepositoryError('Failed to load banners from database', error);
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics?.dbQueryDuration.observe(durationSeconds);
    }
  }

  /**
   * @param epochAtStart The `invalidationEpoch` value captured before the
   *   database load that produced `banners` began. If an `invalidate()` call
   *   has bumped the epoch since then, this fill is stale — dropped instead
   *   of written, so a slow leader can never resurrect pre-invalidation data
   *   after a newer invalidation has already run. See `invalidationEpoch`.
   */
  private async populateCaches(banners: Banner[], epochAtStart: number): Promise<void> {
    const fillStart = process.hrtime.bigint();
    const payload = serializePayload(banners);

    if (this.invalidationEpoch !== epochAtStart) {
      this.metrics?.cacheEventsTotal.inc({ layer: 'in-memory', event: 'stale-fill-dropped' });
      this.logger.warn(
        { epochAtStart, currentEpoch: this.invalidationEpoch },
        'Dropping stale cache fill: an invalidation occurred while the database load was in flight',
      );
      return;
    }

    this.localCache.set(ACTIVE_BANNERS_CACHE_KEY, payload, this.options.localCacheTtlMs);

    if (this.circuit.isOpen()) return;
    try {
      await this.cache.set(
        ACTIVE_BANNERS_CACHE_KEY,
        JSON.stringify(payload),
        this.options.cacheTtlSeconds,
      );
      this.circuit.recordSuccess();
      this.metrics?.recordCircuitState(this.circuit.getState());
    } catch (error) {
      this.recordCacheFailure(error, 'Redis SET failed; database result still served');
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - fillStart) / 1e9;
      this.metrics?.cacheFillDuration.observe(durationSeconds);
    }
  }

  /**
   * Evicts both cache layers and bumps the invalidation epoch. Called by the
   * CMS invalidation listener on banner create/update/delete events (see
   * `infrastructure/events/in-process-event-bus.ts` for the test/dev
   * consumer wiring, and the README for the production outbox integration
   * point).
   *
   * `occurredAt`, when provided, is used to record `cache_invalidation_lag_seconds`
   * — the delay between the CMS event's own timestamp and this eviction
   * actually running.
   */
  public async invalidate(occurredAt?: Date): Promise<void> {
    this.invalidationEpoch += 1;
    this.localCache.delete(ACTIVE_BANNERS_CACHE_KEY);
    try {
      await this.cache.delete(ACTIVE_BANNERS_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Redis invalidation failed; TTL will expire the stale entry',
      );
    }
    if (occurredAt) {
      const lagSeconds = (Date.now() - occurredAt.getTime()) / 1000;
      this.metrics?.invalidationLag.observe(Math.max(0, lagSeconds));
    }
  }

  /**
   * Test-only: clears every layer this instance can reach, including the
   * single-flight lock (which `invalidate()` deliberately leaves alone,
   * since in production a stray lock should simply expire on its own TTL).
   *
   * Guarded at the transport layer — see `shared/test-controls/reset-route.ts`
   * for why this is unreachable unless the process booted with
   * `ENABLE_TEST_CONTROLS=true`. This method itself performs no gating; it
   * assumes the caller has already established that test controls are safe
   * to run.
   */
  public async resetForTesting(): Promise<void> {
    this.invalidationEpoch += 1;
    this.localCache.clear();
    this.inFlight.clear();
    this.circuit.resetForTesting();
    this.metrics?.recordCircuitState(this.circuit.getState());
    try {
      await this.cache.delete(ACTIVE_BANNERS_CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, 'Test reset: Redis cache delete failed');
    }
    try {
      await this.singleFlight.forceReleaseForTesting(ACTIVE_BANNERS_CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, 'Test reset: lease release failed');
    }
  }

  /**
   * Test-only: deterministically expire the per-instance in-memory (Layer 2)
   * entry without waiting out `CACHE_IN_MEMORY_TTL_MS`. Unlike
   * `resetForTesting`, this does NOT touch Redis, the in-flight map, the
   * single-flight lock, or the invalidation epoch — it isolates exactly one
   * variable (local-cache freshness) so a test can force a Redis-layer read
   * on demand instead of sleeping past a real TTL. Guarded by the same
   * transport-layer check as every other test-controls method.
   */
  public expireLocalCacheForTesting(): void {
    this.localCache.delete(ACTIVE_BANNERS_CACHE_KEY);
  }

  /** Test-only: current invalidation epoch, for assertions that a stale fill was dropped. */
  public getInvalidationEpochForTesting(): number {
    return this.invalidationEpoch;
  }

  private recordCacheFailure(error: unknown, message: string): void {
    this.circuit.recordFailure();
    this.metrics?.recordCircuitState(this.circuit.getState());
    this.logger.error({ err: error, circuitState: this.circuit.getState() }, message);
  }
}

/**
 * Projects the internal `ResolutionOutcome` (cross-instance lease role +
 * explicit database-queried flag) onto the public `RequestOutcome` shape.
 * `wasLeaseHolder` / `wasLeaseWaiter` here describe the CROSS-INSTANCE lease
 * role, regardless of whether the caller reached this outcome by winning the
 * local in-flight promise race or by awaiting someone else's.
 */
function toRequestOutcome(resolved: ResolutionOutcome): RequestOutcome {
  return {
    banners: resolved.banners,
    servedBy: resolved.servedBy,
    wasLeaseHolder: resolved.leaseRole === 'leader',
    wasLeaseWaiter: resolved.leaseRole === 'waiter',
  };
}

/* --------------------------- payload (de)serialization -------------------- */

interface RawBanner extends Omit<Banner, 'startDate' | 'endDate' | 'createdAt' | 'updatedAt'> {
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializePayload(banners: Banner[]): CachedBannerPayload {
  return { banners };
}

export function deserializePayload(raw: string): CachedBannerPayload {
  const parsed = JSON.parse(raw) as { banners: RawBanner[] };
  return {
    banners: parsed.banners.map(reviveBanner),
  };
}

function reviveBanner(raw: RawBanner): Banner {
  return {
    ...raw,
    startDate: raw.startDate ? new Date(raw.startDate) : null,
    endDate: raw.endDate ? new Date(raw.endDate) : null,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
}
