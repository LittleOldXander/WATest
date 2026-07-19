import {
  BannerService,
  serializePayload,
  type CachedBannerPayload,
} from '../../../../src/modules/banners/application/banner-service.js';
import { ACTIVE_BANNERS_CACHE_KEY } from '../../../../src/modules/banners/application/banner-cache-keys.js';
import { CircuitBreaker } from '../../../../src/shared/resilience/circuit-breaker.js';
import { silentLogger } from '../../../../src/shared/observability/logger.js';
import { Metrics } from '../../../../src/shared/observability/metrics.js';
import type { Banner } from '../../../../src/modules/banners/domain/banner.js';
import {
  FakeBannerCache,
  FakeLocalCache,
  FakeRepository,
  FakeSingleFlight,
  makeBanner,
  sleep,
} from '../../helpers/fakes.js';

interface ServiceParts {
  repository: FakeRepository;
  cache: FakeBannerCache;
  localCache: FakeLocalCache<CachedBannerPayload>;
  singleFlight: FakeSingleFlight;
  circuitBreaker: CircuitBreaker;
  metrics: Metrics;
}

function makeService(overrides: Partial<ServiceParts> = {}): ServiceParts & {
  service: BannerService;
} {
  const repository = overrides.repository ?? new FakeRepository();
  const cache = overrides.cache ?? new FakeBannerCache();
  const localCache = overrides.localCache ?? new FakeLocalCache<CachedBannerPayload>();
  const singleFlight = overrides.singleFlight ?? new FakeSingleFlight();
  const circuitBreaker = overrides.circuitBreaker ?? new CircuitBreaker();
  const metrics = overrides.metrics ?? new Metrics();

  const service = new BannerService({
    repository,
    cache,
    localCache,
    singleFlight,
    circuitBreaker,
    logger: silentLogger,
    options: { cacheTtlSeconds: 30, localCacheTtlMs: 5000 },
    metrics,
  });

  return { service, repository, cache, localCache, singleFlight, circuitBreaker, metrics };
}

/** Reads a single Prometheus counter series' value by exact label match. */
async function counterValue(
  metrics: Metrics,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await metrics.registry.getSingleMetricAsString(name);
  const labelPairs = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  for (const line of metric.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.startsWith(`${name}{`)) continue;
    if (!line.includes(labelPairs)) continue;
    // Guard against a superset match (e.g. an extra label) by checking the
    // label block is followed immediately by `}` for at least one of the
    // expected pairs — good enough given the fixed, known label sets here.
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/** Builds the exact wire format the Redis layer stores. */
function cachedPayloadJson(banners: Banner[]): string {
  return JSON.stringify(serializePayload(banners));
}

describe('BannerService: three-level cache flow', () => {
  it('an in-memory hit does not call Redis or the database', async () => {
    const { service, repository, cache, localCache } = makeService();
    localCache.set(ACTIVE_BANNERS_CACHE_KEY, serializePayload([makeBanner()]));

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('in-memory');
    expect(cache.getCalls).toBe(0);
    expect(repository.callCount).toBe(0);
  });

  it('an in-memory miss plus a Redis hit populates in-memory and does not call the database', async () => {
    const { service, repository, cache, localCache } = makeService();
    const banner = makeBanner();
    cache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([banner]));

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('redis');
    expect(repository.callCount).toBe(0);
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(result.banners[0]?.id).toBe(banner.id);
  });

  it('revives Date fields when reading a Redis payload', async () => {
    const { service, cache } = makeService();
    const banner = makeBanner({
      startDate: new Date('2025-01-01T00:00:00.000Z'),
      endDate: new Date('2027-01-01T00:00:00.000Z'),
    });
    cache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([banner]));

    const result = await service.getActiveBanners();

    expect(result.banners[0]?.startDate).toBeInstanceOf(Date);
    expect(result.banners[0]?.updatedAt).toBeInstanceOf(Date);
    expect(result.banners[0]?.startDate?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('an in-memory and Redis miss calls the database once, then populates Redis and in-memory', async () => {
    const { service, repository, cache, localCache } = makeService();

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(repository.callCount).toBe(1);
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
  });

  it('writes the in-memory entry with the SHORT local TTL, not the Redis TTL', async () => {
    // Regression guard: the local cache is per-instance, so its TTL bounds how
    // long two replicas can disagree. Reusing the 30s Redis TTL here would
    // silently widen that window and make CACHE_IN_MEMORY_TTL_MS a no-op.
    const { service, localCache } = makeService();

    await service.getActiveBanners(); // database load -> populates both layers

    expect(localCache.lastTtlMs).toBe(5000);
    expect(localCache.lastTtlMs).not.toBe(30 * 1000);
  });

  it('uses the local TTL when populating in-memory from a Redis hit too', async () => {
    const { service, cache, localCache } = makeService();
    cache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([makeBanner()]));

    await service.getActiveBanners();

    expect(localCache.lastTtlMs).toBe(5000);
  });

  it('expiry falls through to the next cache layer', async () => {
    const { service, repository, localCache } = makeService();

    await service.getActiveBanners();
    expect(repository.callCount).toBe(1);

    // Simulate in-memory TTL expiry while Redis still holds the payload.
    localCache.clear();
    const second = await service.getActiveBanners();

    expect(second.servedBy).toBe('redis');
    expect(repository.callCount).toBe(1);
  });
});

describe('BannerService: Redis failure and circuit breaker', () => {
  it('Redis GET/SET failure returns database data and still serves the request', async () => {
    const cache = new FakeBannerCache();
    cache.shouldFailGet = true;
    cache.shouldFailSet = true;
    const { service, repository } = makeService({ cache });

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(result.banners).toHaveLength(1);
    expect(repository.callCount).toBe(1);
  });

  it('repeated Redis failures open the circuit and temporarily bypass Redis', async () => {
    const cache = new FakeBannerCache();
    cache.shouldFailGet = true;
    cache.shouldFailSet = true;
    const circuitBreaker = new CircuitBreaker(3, 10_000);
    const { service, localCache } = makeService({ cache, circuitBreaker });

    // Pass 1: GET failure (1) + SET failure (2) -> still below threshold.
    localCache.clear();
    await service.getActiveBanners();
    expect(circuitBreaker.getState()).toBe('closed');

    // Pass 2: GET failure (3) -> circuit opens.
    localCache.clear();
    await service.getActiveBanners();
    expect(circuitBreaker.getState()).toBe('open');

    // Pass 3: circuit is open, so Redis is not contacted at all.
    const callsBefore = cache.getCalls;
    localCache.clear();
    const result = await service.getActiveBanners();

    expect(cache.getCalls).toBe(callsBefore);
    expect(result.servedBy).toBe('database');
  });
});

describe('BannerService: database failure', () => {
  it('propagates a RepositoryError (mapped to 503 by the HTTP layer)', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true;
    const { service } = makeService({ repository });

    await expect(service.getActiveBanners()).rejects.toThrow('simulated database failure');
  });
});

describe('BannerService: invalidation', () => {
  it('clears both the in-memory and Redis entries', async () => {
    const { service, cache, localCache } = makeService();
    await service.getActiveBanners();

    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();

    await service.invalidate();

    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
  });
});

describe('BannerService: local request collapsing', () => {
  it('collapses concurrent requests for one missing key into exactly one database query', async () => {
    const repository = new FakeRepository();
    repository.delayMs = 50;
    const { service } = makeService({ repository });

    const results = await Promise.all([
      service.getActiveBanners(),
      service.getActiveBanners(),
      service.getActiveBanners(),
      service.getActiveBanners(),
      service.getActiveBanners(),
    ]);

    expect(repository.callCount).toBe(1);
    expect(results).toHaveLength(5);
    // wasLeaseHolder/wasLeaseWaiter describe the CROSS-INSTANCE (Redis) lease
    // role, not which side of the LOCAL in-process promise race a caller
    // landed on. With no lease contention (single instance, uncontested
    // FakeSingleFlight), every one of these five callers — the local leader
    // and its four local waiters alike — relays the SAME cross-instance
    // lease-leader outcome, since none of them ever lost a Redis lease to
    // another replica. All five must therefore report wasLeaseHolder: true.
    expect(results.filter((r) => r.wasLeaseHolder)).toHaveLength(5);
    expect(results.filter((r) => r.wasLeaseWaiter)).toHaveLength(0);
    expect(results.every((r) => r.servedBy === 'database')).toBe(true);
  });

  it('cleans up memoization after a successful database call', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });

    await service.getActiveBanners();
    await service.invalidate();
    await service.getActiveBanners();

    // A second load happened, proving the in-flight entry was not retained.
    expect(repository.callCount).toBe(2);
  });

  it('cleans up memoization after a failed database call', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true;
    const { service } = makeService({ repository });

    await expect(service.getActiveBanners()).rejects.toThrow();

    // The next call must retry rather than await a retained rejected promise.
    repository.shouldFail = false;
    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(repository.callCount).toBe(2);
  });
});

describe('BannerService: cross-instance single-flight lease', () => {
  /** Two replicas sharing one Redis, each with its own local cache + memo map. */
  function makeTwoInstances(repository: FakeRepository) {
    const cacheA = new FakeBannerCache();
    const singleFlightA = new FakeSingleFlight();

    const instanceA = makeService({ repository, cache: cacheA, singleFlight: singleFlightA });
    const instanceB = makeService({
      repository,
      cache: cacheA.fork(),
      singleFlight: singleFlightA.fork(),
    });

    return { instanceA, instanceB };
  }

  it('two instances missing the same key acquire one lease and make exactly one database query', async () => {
    const repository = new FakeRepository();
    repository.delayMs = 60;
    const { instanceA, instanceB } = makeTwoInstances(repository);

    const [resultA, resultB] = await Promise.all([
      instanceA.service.getActiveBanners(),
      instanceB.service.getActiveBanners(),
    ]);

    expect(repository.callCount).toBe(1);
    expect(resultA.banners.map((b) => b.id)).toEqual(resultB.banners.map((b) => b.id));

    // Exactly one of the two is the true cross-instance lease leader (the
    // one that actually queried the database); the other is the waiter that
    // relayed the Redis-filled result. Never both, never neither.
    const holders = [resultA, resultB].filter((r) => r.wasLeaseHolder);
    const waiters = [resultA, resultB].filter((r) => r.wasLeaseWaiter);
    expect(holders).toHaveLength(1);
    expect(waiters).toHaveLength(1);
    expect(holders[0]?.servedBy).toBe('database');
    expect(waiters[0]?.servedBy).toBe('redis');
  });

  it('a non-lease-owner waits, then returns the Redis-filled result without querying the database', async () => {
    const repository = new FakeRepository();
    const leaderSingleFlight = new FakeSingleFlight();
    const leaderCache = new FakeBannerCache();

    // The "other replica" already holds the lease.
    const lease = await leaderSingleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);
    expect(lease.acquired).toBe(true);

    const waiter = makeService({
      repository,
      cache: leaderCache.fork(),
      singleFlight: leaderSingleFlight.fork(),
    });

    const waiterPromise = waiter.service.getActiveBanners();

    // Let the waiter get past its cache reads and actually block on the lease.
    // Without this it would still be mid-flight and would win the lease itself.
    await sleep(20);

    // Leader finishes: fills Redis, then releases + notifies.
    const banner = makeBanner({ id: 'from-leader' });
    leaderCache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([banner]));
    await leaderSingleFlight.release(ACTIVE_BANNERS_CACHE_KEY, lease.token!);

    const result = await waiterPromise;

    expect(repository.callCount).toBe(0);
    expect(result.banners[0]?.id).toBe('from-leader');
    // The waiter never queried the database — its data came from the
    // leader's Redis fill, so `servedBy` must say so, not 'database'.
    expect(result.servedBy).toBe('redis');
    // Regression guard for the metadata bug: a cross-instance lease WAITER
    // must report wasLeaseHolder: false / wasLeaseWaiter: true, never the
    // reverse, regardless of whether it happened to win the local in-flight
    // promise race on its own instance.
    expect(result.wasLeaseHolder).toBe(false);
    expect(result.wasLeaseWaiter).toBe(true);
  });

  it(
    'regression: a LOCAL in-flight leader that is itself a CROSS-INSTANCE lease ' +
      'waiter reports the true (redis/waiter) outcome, not a hardcoded database/leader one',
    async () => {
      // This is the exact bug: the local in-flight leader used to always
      // report servedBy: 'database', wasLeaseHolder: true regardless of what
      // actually happened underneath. Here, THIS instance loses the
      // cross-instance Redis lease to another replica, waits, and relays the
      // Redis-filled result — while also being the local in-flight leader
      // for two other same-instance callers collapsed behind it.
      const repository = new FakeRepository();
      const leaderSingleFlight = new FakeSingleFlight();
      const leaderCache = new FakeBannerCache();

      // Another replica already holds the cross-instance lease.
      const otherReplicaLease = await leaderSingleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);
      expect(otherReplicaLease.acquired).toBe(true);

      const thisInstance = makeService({
        repository,
        cache: leaderCache.fork(),
        singleFlight: leaderSingleFlight.fork(),
      });

      // Three concurrent callers on THIS SAME instance: one becomes the local
      // in-flight leader, the other two become local in-flight waiters. All
      // three ultimately relay the same underlying cross-instance outcome.
      const resultsPromise = Promise.all([
        thisInstance.service.getActiveBanners(),
        thisInstance.service.getActiveBanners(),
        thisInstance.service.getActiveBanners(),
      ]);

      // Let the local leader get past its cache reads and actually block on
      // the cross-instance lease wait.
      await sleep(20);

      // The other replica finishes: fills Redis, releases + notifies.
      const banner = makeBanner({ id: 'from-other-replica' });
      leaderCache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([banner]));
      await leaderSingleFlight.release(ACTIVE_BANNERS_CACHE_KEY, otherReplicaLease.token!);

      const results = await resultsPromise;

      // This instance never touched the database.
      expect(repository.callCount).toBe(0);
      for (const result of results) {
        expect(result.banners[0]?.id).toBe('from-other-replica');
        expect(result.servedBy).toBe('redis');
        expect(result.wasLeaseHolder).toBe(false);
        expect(result.wasLeaseWaiter).toBe(true);
      }
    },
  );

  it('release is token-safe: a mismatched token does not free the lock', async () => {
    const singleFlight = new FakeSingleFlight();
    const lease = await singleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);
    expect(lease.acquired).toBe(true);

    await singleFlight.release(ACTIVE_BANNERS_CACHE_KEY, 'not-the-real-token');

    // Still held, so a second acquirer is refused.
    const second = await singleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);
    expect(second.acquired).toBe(false);
  });

  it('recovers from a crashed lease owner once the lease expires', async () => {
    const singleFlight = new FakeSingleFlight();
    await singleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY); // owner then "crashes"
    singleFlight.forceExpireLock(ACTIVE_BANNERS_CACHE_KEY); // TTL expiry

    const repository = new FakeRepository();
    const { service } = makeService({ repository, singleFlight: singleFlight.fork() });

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(repository.callCount).toBe(1);
    // This instance acquired the (now-expired, recovered) lease itself and
    // queried the database, so it is the lease holder, not a waiter.
    expect(result.wasLeaseHolder).toBe(true);
    expect(result.wasLeaseWaiter).toBe(false);
  });

  it('bounds the wait: a stuck leader does not block the request forever', async () => {
    const singleFlight = new FakeSingleFlight();
    // Leader acquires and never releases or notifies.
    await singleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);

    const repository = new FakeRepository();
    const { service } = makeService({ repository, singleFlight: singleFlight.fork() });

    const result = await service.getActiveBanners();

    // Wait timed out, Redis was still empty, so we failed open to the database.
    expect(result.servedBy).toBe('database');
    expect(repository.callCount).toBe(1);
    // This instance never held the cross-instance lease — another replica
    // did — so it must NOT be reported as a lease holder even though it
    // ended up querying the database itself via the fail-open path.
    // Do NOT report headers/metrics that say "database" implies "leader";
    // here it queried the database as a lease waiter that failed open.
    expect(result.wasLeaseHolder).toBe(false);
    expect(result.wasLeaseWaiter).toBe(true);
  });

  it('Redis loss disables coordination but preserves database fail-open behavior', async () => {
    const cache = new FakeBannerCache();
    cache.shouldFailGet = true;
    cache.shouldFailSet = true;
    const singleFlight = new FakeSingleFlight();
    singleFlight.shouldFailAcquire = true;

    const repository = new FakeRepository();
    const { service } = makeService({ repository, cache, singleFlight });

    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(result.banners).toHaveLength(1);
    expect(repository.callCount).toBe(1);
    // No coordination was possible at all (acquire itself failed), so this
    // instance fails open as if it were the leader — it did query the
    // database directly.
    expect(result.wasLeaseHolder).toBe(true);
    expect(result.wasLeaseWaiter).toBe(false);
  });
});

describe('BannerService: Prometheus metrics distinguish every role', () => {
  it('counts a local leader that is also the cross-instance leader under both scopes, and one real db query', async () => {
    const repository = new FakeRepository();
    const { service, metrics } = makeService({ repository });

    await service.getActiveBanners();

    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'local',
        role: 'leader',
      }),
    ).toBe(1);
    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'cross-instance',
        role: 'leader',
      }),
    ).toBe(1);
    expect(await counterValue(metrics, 'db_queries_total', { outcome: 'success' })).toBe(1);
  });

  it('counts local waiters separately from local leaders when requests collapse on one instance', async () => {
    const repository = new FakeRepository();
    repository.delayMs = 30;
    const { service, metrics } = makeService({ repository });

    await Promise.all([
      service.getActiveBanners(),
      service.getActiveBanners(),
      service.getActiveBanners(),
    ]);

    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'local',
        role: 'leader',
      }),
    ).toBe(1);
    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'local',
        role: 'waiter',
      }),
    ).toBe(2);
    // Only ONE database query cluster-wide (well, instance-wide here), no
    // matter how many local callers collapsed behind the leader.
    expect(await counterValue(metrics, 'db_queries_total', { outcome: 'success' })).toBe(1);
  });

  it('counts a cross-instance waiter distinctly from a cross-instance leader, and records zero extra db queries for the waiter', async () => {
    const repository = new FakeRepository();
    const leaderSingleFlight = new FakeSingleFlight();
    const leaderCache = new FakeBannerCache();

    const lease = await leaderSingleFlight.acquire(ACTIVE_BANNERS_CACHE_KEY);

    const { service, metrics } = makeService({
      repository,
      cache: leaderCache.fork(),
      singleFlight: leaderSingleFlight.fork(),
    });

    const waiterPromise = service.getActiveBanners();
    await sleep(20);

    const banner = makeBanner({ id: 'from-leader' });
    leaderCache.state.store.set(ACTIVE_BANNERS_CACHE_KEY, cachedPayloadJson([banner]));
    await leaderSingleFlight.release(ACTIVE_BANNERS_CACHE_KEY, lease.token!);

    await waiterPromise;

    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'cross-instance',
        role: 'waiter',
      }),
    ).toBe(1);
    expect(
      await counterValue(metrics, 'request_collapsing_events_total', {
        scope: 'cross-instance',
        role: 'leader',
      }),
    ).toBe(0);
    // The critical assertion for this bug fix: a cross-instance waiter that
    // relayed Redis data must NOT be counted as a database query. Headers
    // and metrics must never claim "database" for an instance that never
    // queried MongoDB.
    expect(await counterValue(metrics, 'db_queries_total', { outcome: 'success' })).toBe(0);
    expect(repository.callCount).toBe(0);
  });
});
