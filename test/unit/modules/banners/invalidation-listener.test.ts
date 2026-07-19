import {
  BannerService,
  type CachedBannerPayload,
} from '../../../../src/modules/banners/application/banner-service.js';
import { InvalidationListener } from '../../../../src/modules/banners/application/invalidation-listener.js';
import { ACTIVE_BANNERS_CACHE_KEY } from '../../../../src/modules/banners/application/banner-cache-keys.js';
import { InProcessEventBus } from '../../../../src/modules/banners/infrastructure/events/in-process-event-bus.js';
import { CircuitBreaker } from '../../../../src/shared/resilience/circuit-breaker.js';
import { silentLogger } from '../../../../src/shared/observability/logger.js';
import { Metrics } from '../../../../src/shared/observability/metrics.js';
import {
  FakeBannerCache,
  FakeLocalCache,
  FakeRepository,
  FakeSingleFlight,
} from '../../helpers/fakes.js';

function makeService() {
  const repository = new FakeRepository();
  const cache = new FakeBannerCache();
  const localCache = new FakeLocalCache<CachedBannerPayload>();
  const singleFlight = new FakeSingleFlight();
  const metrics = new Metrics();

  const service = new BannerService({
    repository,
    cache,
    localCache,
    singleFlight,
    circuitBreaker: new CircuitBreaker(),
    logger: silentLogger,
    options: { cacheTtlSeconds: 30, localCacheTtlMs: 5000 },
    metrics,
  });

  return { service, repository, cache, localCache, singleFlight, metrics };
}

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
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

describe('InvalidationListener: CMS event -> cache eviction', () => {
  it('a BannerChanged event evicts both the in-memory and Redis entries', async () => {
    const { service, cache, localCache } = makeService();
    const bus = new InProcessEventBus();
    new InvalidationListener(bus, service, silentLogger);

    await service.getActiveBanners(); // populate both layers
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();

    await bus.publish({ bannerId: 'b-1', operation: 'updated', occurredAt: new Date() });

    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
  });

  it('publish() does not resolve until the invalidation handler has finished', async () => {
    const { service, localCache } = makeService();
    const bus = new InProcessEventBus();
    new InvalidationListener(bus, service, silentLogger);

    await service.getActiveBanners();
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();

    await bus.publish({ bannerId: 'b-1', operation: 'deleted', occurredAt: new Date() });

    // No sleep/poll needed: by the time publish() resolves, invalidation has
    // definitely already happened. This is what makes the CMS-event
    // integration tests deterministic.
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
  });

  it('records invalidation lag from the event timestamp to handling time', async () => {
    const { service, metrics } = makeService();
    const bus = new InProcessEventBus();
    new InvalidationListener(bus, service, silentLogger);

    const occurredAt = new Date(Date.now() - 250);
    await bus.publish({ bannerId: 'b-1', operation: 'updated', occurredAt });

    const summary = await metrics.registry.getSingleMetricAsString(
      'cache_invalidation_lag_seconds',
    );
    // A _count of 1 proves an observation was recorded; the exact bucket
    // depends on timing, so we only assert that recording happened.
    expect(summary).toContain('cache_invalidation_lag_seconds_count 1');
  });

  it('multiple registered listeners on the same bus all receive the event', async () => {
    const { service: serviceA, localCache: localA } = makeService();
    const { service: serviceB, localCache: localB } = makeService();
    const bus = new InProcessEventBus();
    new InvalidationListener(bus, serviceA, silentLogger);
    new InvalidationListener(bus, serviceB, silentLogger);

    await serviceA.getActiveBanners();
    await serviceB.getActiveBanners();

    await bus.publish({ bannerId: 'b-1', operation: 'updated', occurredAt: new Date() });

    expect(localA.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
    expect(localB.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
  });
});

describe('BannerService: stale in-flight fill cannot overwrite newer invalidated data', () => {
  it('drops a database fill that started before an invalidation which completed while the load was in flight', async () => {
    const repository = new FakeRepository();
    repository.delayMs = 50;
    const { localCache, cache, metrics } = makeService();
    // makeService() above doesn't take overrides; construct directly here
    // with the slow repository.
    const slow = new BannerService({
      repository,
      cache,
      localCache,
      singleFlight: new FakeSingleFlight(),
      circuitBreaker: new CircuitBreaker(),
      logger: silentLogger,
      options: { cacheTtlSeconds: 30, localCacheTtlMs: 5000 },
      metrics,
    });

    // Start a request that misses everything and begins a slow database load.
    const requestPromise = slow.getActiveBanners();

    // While that load is still in flight, an invalidation arrives (e.g. the
    // CMS event bus fired for an unrelated, newer write) and bumps the epoch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await slow.invalidate();
    const epochAfterInvalidate = slow.getInvalidationEpochForTesting();

    const result = await requestPromise;

    // The in-flight request still gets an answer (it does not fail or hang)...
    expect(result.banners).toHaveLength(1);
    expect(repository.callCount).toBe(1);

    // ...but its now-stale fill must NOT have been written to either cache:
    // a fill that started before the invalidation is not allowed to
    // resurrect pre-invalidation data after the invalidation has already run.
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeUndefined();

    // The epoch was not disturbed by the dropped fill.
    expect(slow.getInvalidationEpochForTesting()).toBe(epochAfterInvalidate);

    // The drop is itself observable via metrics, not just inferred silently.
    expect(
      await counterValue(metrics, 'cache_events_total', {
        layer: 'in-memory',
        event: 'stale-fill-dropped',
      }),
    ).toBe(1);

    // Proof the guard is not just "never populate caches": a subsequent,
    // un-raced request populates them normally.
    const next = await slow.getActiveBanners();
    expect(next.servedBy).toBe('database');
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
  });

  it('a fill that completes with no intervening invalidation is written normally', async () => {
    const { service, localCache, cache } = makeService();

    await service.invalidate(); // bump epoch once, unrelated to the load below
    const result = await service.getActiveBanners();

    expect(result.servedBy).toBe('database');
    expect(localCache.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
    expect(cache.state.store.get(ACTIVE_BANNERS_CACHE_KEY)).toBeDefined();
  });
});
