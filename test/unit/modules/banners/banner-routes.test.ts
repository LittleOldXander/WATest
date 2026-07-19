import { buildApp } from '../../../../src/app/build-app.js';
import {
  BannerService,
  type CachedBannerPayload,
} from '../../../../src/modules/banners/application/banner-service.js';
import { CircuitBreaker } from '../../../../src/shared/resilience/circuit-breaker.js';
import { Metrics } from '../../../../src/shared/observability/metrics.js';
import { silentLogger } from '../../../../src/shared/observability/logger.js';
import {
  FakeBannerCache,
  FakeLocalCache,
  FakeRepository,
  FakeSingleFlight,
  makeBanner,
} from '../../helpers/fakes.js';

function buildTestApp(
  overrides: { repository?: FakeRepository; allowTestCacheBust?: boolean } = {},
) {
  const repository = overrides.repository ?? new FakeRepository();

  const bannerService = new BannerService({
    repository,
    cache: new FakeBannerCache(),
    localCache: new FakeLocalCache<CachedBannerPayload>(),
    singleFlight: new FakeSingleFlight(),
    circuitBreaker: new CircuitBreaker(),
    logger: silentLogger,
    options: { cacheTtlSeconds: 30, localCacheTtlMs: 5000 },
  });

  const app = buildApp({
    bannerService,
    metrics: new Metrics(),
    logger: false,
    // With `exactOptionalPropertyTypes`, an optional property must be omitted
    // rather than explicitly passed as `undefined`.
    allowTestCacheBust: overrides.allowTestCacheBust ?? false,
  });
  return { app, repository, bannerService };
}

describe('GET /api/banners', () => {
  it('returns 200 with a { banners: [...] } envelope', async () => {
    const { app } = buildTestApp({ allowTestCacheBust: true });

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ banners: unknown[] }>();
    expect(Array.isArray(body.banners)).toBe(true);
    expect(body.banners).toHaveLength(1);
  });

  it('emits CDN-friendly cache headers and the serving layer', async () => {
    const { app } = buildTestApp({ allowTestCacheBust: true });

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.headers['cache-control']).toContain('s-maxage=10');
    expect(response.headers['cache-control']).toContain('stale-while-revalidate=30');
    expect(response.headers['x-served-by']).toBe('database');
  });

  it('serializes dates as ISO-8601 strings, preserving the API contract', async () => {
    const repository = new FakeRepository([
      makeBanner({
        id: 'iso-check',
        startDate: new Date('2026-03-01T00:00:00.000Z'),
        endDate: null,
      }),
    ]);
    const { app } = buildTestApp({ repository });

    const response = await app.inject({ method: 'GET', url: '/api/banners' });
    const [banner] = response.json<{
      banners: { startDate: string | null; endDate: string | null; createdAt: string }[];
    }>().banners;

    expect(banner.startDate).toBe('2026-03-01T00:00:00.000Z');
    expect(banner.endDate).toBeNull();
    expect(banner.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns a controlled 503 JSON body when the database fails', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true;
    const { app } = buildTestApp({ repository });

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Banner service temporarily unavailable' });
  });

  it('never caches an error response', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true;
    const { app } = buildTestApp({ repository });

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns a generic 500 response for an unexpected failure', async () => {
    const { app, bannerService } = buildTestApp();
    jest
      .spyOn(bannerService, 'getActiveBanners')
      .mockRejectedValue(new Error('unexpected failure'));

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/banners: query parameter validation', () => {
  it('accepts a request with no query parameters', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/banners' });

    expect(response.statusCode).toBe(200);
  });

  it('accepts a well-formed cachebust UUID only in a test-enabled app', async () => {
    const { app } = buildTestApp({ allowTestCacheBust: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/banners?cachebust=3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects cachebust in a production-shaped app', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/banners?cachebust=3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed cachebust value with 400', async () => {
    const { app } = buildTestApp({ allowTestCacheBust: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/banners?cachebust=not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('rejects an unknown query parameter with 400', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/banners?limit=10',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBeDefined();
  });

  it('rejects a request that mixes a valid and an unknown parameter', async () => {
    const { app } = buildTestApp({ allowTestCacheBust: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/banners?cachebust=3fa85f64-5717-4562-b3fc-2c963f66afa6&debug=true',
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not cache a 400 validation error at the edge-facing headers', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/banners?limit=10' });

    // The route's success path sets a long-lived Cache-Control; a validation
    // failure short-circuits before the handler runs, so no Cache-Control is
    // set at all — in particular never the long-lived success-path header,
    // so an edge/CDN in front of this service has no cacheable signal for a 400.
    expect(response.headers['cache-control']).toBeUndefined();
  });
});

describe('operational endpoints', () => {
  it('GET /healthz reports liveness without touching dependencies', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true; // dependencies down...
    const { app } = buildTestApp({ repository });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200); // ...but the process is still alive
  });

  it('GET /readyz reports 503 when a dependency is down', async () => {
    const bannerService = new BannerService({
      repository: new FakeRepository(),
      cache: new FakeBannerCache(),
      localCache: new FakeLocalCache<CachedBannerPayload>(),
      singleFlight: new FakeSingleFlight(),
      circuitBreaker: new CircuitBreaker(),
      logger: silentLogger,
      options: { cacheTtlSeconds: 30, localCacheTtlMs: 5000 },
    });

    const app = buildApp({
      bannerService,
      metrics: new Metrics(),
      logger: false,
      checkReadiness: async () => ({ mongo: 'down' as const, redis: 'up' as const }),
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'degraded' });
  });

  it('GET /metrics exposes Prometheus counters', async () => {
    const { app } = buildTestApp();
    await app.inject({ method: 'GET', url: '/api/banners' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('http_requests_total');
    expect(response.body).toContain('cache_events_total');
  });
});
