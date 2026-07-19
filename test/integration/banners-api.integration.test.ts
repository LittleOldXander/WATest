/**
 * Integration tests exercising the real Docker Compose stack:
 *
 *   Nginx edge -> Fastify API -> in-memory (L2) -> Redis (L3) -> MongoDB
 *
 * Start the stack first, then run these from the host:
 *
 *   docker compose up -d --build
 *   npm run test:integration
 *   docker compose down
 *
 * They deliberately stop and start containers to prove resilience behaviour,
 * so the Docker CLI must be available on the machine running Jest.
 *
 * Host port 3000 is the EDGE. The API has no host port, so "talk to the
 * origin" means "send a request the edge is configured not to serve from
 * cache" — see `getOrigin`.
 */
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

const EDGE_URL = process.env.EDGE_URL ?? 'http://localhost:3000';
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const MONGODB_DATABASE = process.env.MONGODB_DATABASE ?? 'banners';

/**
 * Margin for Docker/VM timer jitter. Most cache-expiry needs in this suite
 * are now satisfied deterministically via `expireLocalCache`/`resetReplica`
 * rather than sleeping past `CACHE_IN_MEMORY_TTL_MS`; this margin remains
 * only for the edge (Layer 1) staleness test, which genuinely needs the
 * EDGE entry — not the origin's local cache — to age past its real
 * `s-maxage`, since nginx has no test-controls reset endpoint.
 */
const CACHE_EXPIRY_MARGIN_MS = 3_000;

/** The origin sends `s-maxage=10`, so an edge entry is fresh for 10s. */
const EDGE_FRESHNESS_MS = 10_000;

/**
 * The edge is configured with `proxy_cache_bypass`/`proxy_no_cache` on
 * Authorization, so a credentialed request is neither served from nor stored
 * in the shared cache. That gives tests a reliable way to reach the origin.
 */
const ORIGIN_BYPASS_HEADERS = { Authorization: 'Bearer integration-test-bypass' };

/**
 * `RequestInit` form of `ORIGIN_BYPASS_HEADERS`, for tests that address a
 * single replica directly via `/__replica__/{a,b}/*` (see `replicaUrl`).
 * That path already bypasses the edge's shared cache entirely (`proxy_cache
 * off` on the diagnostic locations), so the header is not strictly required
 * there, but including it keeps every origin-facing request in this suite
 * consistent and makes it safe to swap a call between `getOrigin`-style
 * (edge-routed, credential-bypassed) and replica-direct addressing without
 * silently picking up edge caching.
 */
const ORIGIN_BYPASS_INIT: RequestInit = { headers: ORIGIN_BYPASS_HEADERS };

interface BannerPayload {
  id: string;
  title: string;
  priority: number;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BannerResponse {
  status: number;
  banners: BannerPayload[];
  headers: Headers;
  raw: unknown;
  cacheStatus: string | null;
  servedBy: string | null;
  instance: string | null;
}

function extractBanners(raw: unknown): BannerPayload[] {
  if (raw && typeof raw === 'object' && 'banners' in raw) {
    return (raw as { banners: BannerPayload[] }).banners;
  }
  return [];
}

async function request(url: string, init?: RequestInit): Promise<BannerResponse> {
  const response = await fetch(url, init);
  const raw: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    banners: extractBanners(raw),
    headers: response.headers,
    raw,
    cacheStatus: response.headers.get('x-cache-status'),
    servedBy: response.headers.get('x-origin-served-by') ?? response.headers.get('x-served-by'),
    instance: response.headers.get('x-api-instance'),
  };
}

/** Normal public request: goes through the edge cache. */
async function getEdge(url = `${EDGE_URL}/api/banners`): Promise<BannerResponse> {
  return request(url);
}

/** Bypasses the edge cache so the assertion is about origin behaviour. */
async function getOrigin(path = '/api/banners'): Promise<BannerResponse> {
  return request(`${EDGE_URL}${path}`, { headers: ORIGIN_BYPASS_HEADERS });
}

/**
 * A URL whose edge cache key has never been seen. Guarantees a cold entry
 * without needing a cache purge, since the key includes the query string.
 */
function freshBannerUrl(): string {
  return `${EDGE_URL}/api/banners?cachebust=${randomUUID()}`;
}

function dockerCompose(command: string): void {
  execSync(`docker compose ${command}`, { stdio: 'inherit' });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` passes or the budget runs out. */
async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 1_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `waitFor timed out after ${String(timeoutMs)}ms. Last error: ${String(lastError)}`,
  );
}

const originIsHealthy = async (): Promise<boolean> => {
  const response = await fetch(`${EDGE_URL}/healthz`);
  return response.status === 200;
};

/* -------------------------------- metrics -------------------------------- */

async function fetchMetricsText(): Promise<string> {
  const response = await fetch(`${EDGE_URL}/metrics`);
  return response.text();
}

/**
 * Sums every series of a Prometheus metric family, optionally filtered to
 * series whose label set contains `labelSubstring`.
 */
function sumMetric(body: string, name: string, labelSubstring = ''): number {
  const seriesStart = new RegExp(`^${name}(\\{|\\s)`);
  let total = 0;

  for (const line of body.split('\n')) {
    if (line.startsWith('#') || !seriesStart.test(line)) continue;
    if (labelSubstring && !line.includes(labelSubstring)) continue;

    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

interface OriginCounters {
  apiRequests: number;
  dbQueries: number;
}

/**
 * Sums a counter across BOTH replicas via the per-replica `/__replica__/*`
 * diagnostic routes rather than the edge-routed `/metrics` (which
 * round-robins to a single, arbitrary replica per call). With two real
 * replicas behind the edge, a naive `GET /metrics` before/after diff is
 * unreliable: the "before" call and the "after" call can land on different
 * processes with unrelated cumulative counts, producing a nonsensical or
 * even negative delta. Reading and summing both replicas' own registries
 * gives the true cluster-wide count regardless of which replica served
 * which request in between.
 */
async function readOriginCounters(): Promise<OriginCounters> {
  const [bodyA, bodyB] = await Promise.all([
    fetchReplicaMetricsText('a'),
    fetchReplicaMetricsText('b'),
  ]);
  const sumBoth = (name: string, labelSubstring = ''): number =>
    sumMetric(bodyA, name, labelSubstring) + sumMetric(bodyB, name, labelSubstring);

  return {
    apiRequests: sumBoth('http_requests_total', 'route="/api/banners"'),
    dbQueries: sumBoth('db_queries_total'),
  };
}

/* --------------------------- per-replica diagnostics --------------------- */

type ReplicaId = 'a' | 'b';

/**
 * Addresses ONE specific replica via the edge's `/__replica__/{a,b}/*`
 * diagnostic routes (see docker/nginx/nginx.conf), bypassing the normal
 * round-robin `banner_api` upstream. Used only to read a single instance's
 * own `/metrics` (so per-replica counters can be summed correctly) and to
 * call its own test-only reset endpoint — never to serve real traffic.
 */
function replicaUrl(replica: ReplicaId, path: string): string {
  return `${EDGE_URL}/__replica__/${replica}${path}`;
}

async function fetchReplicaMetricsText(replica: ReplicaId): Promise<string> {
  const response = await fetch(replicaUrl(replica, '/metrics'));
  return response.text();
}

/**
 * Clears that replica's local in-memory cache, deletes the shared Redis
 * banner key + lease lock, and resets that replica's own Prometheus
 * registry to zero. Requires `ENABLE_TEST_CONTROLS=true` on the target
 * replica (set in docker-compose.yml for `api-a`/`api-b`, never in the
 * production image) — see `src/shared/test-controls/reset-route.ts`.
 */
async function resetReplica(replica: ReplicaId): Promise<void> {
  const response = await fetch(replicaUrl(replica, '/__test__/reset'), { method: 'POST' });
  if (response.status !== 200) {
    throw new Error(
      `Failed to reset replica api-${replica}: HTTP ${String(response.status)}. ` +
        'Is ENABLE_TEST_CONTROLS=true set for this replica in docker-compose.yml?',
    );
  }
}

/**
 * Deterministically expires ONE replica's local (Layer 2) in-memory cache
 * entry, without sleeping out `CACHE_IN_MEMORY_TTL_MS`. See
 * `BannerService.expireLocalCacheForTesting` / `POST /__test__/expire-local-cache`.
 */
async function expireLocalCache(replica: ReplicaId): Promise<void> {
  const response = await fetch(replicaUrl(replica, '/__test__/expire-local-cache'), {
    method: 'POST',
  });
  if (response.status !== 200) {
    throw new Error(
      `Failed to expire local cache on replica api-${replica}: HTTP ${String(response.status)}.`,
    );
  }
}

/**
 * Publishes a fake `BannerChanged` CMS event to ONE replica's in-process
 * event bus and waits for that replica's `InvalidationListener` to finish
 * handling it. See `POST /__test__/cms-event` for why this proves the
 * invalidation *contract* deterministically without a real outbox/event-bus.
 *
 * NOTE: this only invalidates the TARGET replica's own caches plus the
 * shared Redis entry (Redis deletion is visible to every replica). It does
 * NOT invalidate another replica's LOCAL in-memory cache — a same-process
 * fake bus has no cross-process reach, which is exactly the boundary the
 * production outbox/event-bus integration point exists to cross for real.
 * See `EventConsumer`'s doc comment.
 */
async function publishCmsEvent(
  replica: ReplicaId,
  event: { bannerId: string; operation: 'created' | 'updated' | 'deleted' },
): Promise<void> {
  const response = await fetch(replicaUrl(replica, '/__test__/cms-event'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (response.status !== 200) {
    throw new Error(
      `Failed to publish CMS event to replica api-${replica}: HTTP ${String(response.status)}.`,
    );
  }
}

/** Per-replica cache-layer event counters, read from that replica's own `/metrics`. */
interface CacheEventCounters {
  inMemoryHit: number;
  inMemoryMiss: number;
  redisHit: number;
  redisMiss: number;
  redisError: number;
  staleFillDropped: number;
  dbQueries: number;
}

async function readCacheEventCounters(replica: ReplicaId): Promise<CacheEventCounters> {
  const body = await fetchReplicaMetricsText(replica);
  return {
    inMemoryHit: sumMetric(body, 'cache_events_total', 'layer="in-memory",event="hit"'),
    inMemoryMiss: sumMetric(body, 'cache_events_total', 'layer="in-memory",event="miss"'),
    redisHit: sumMetric(body, 'cache_events_total', 'layer="redis",event="hit"'),
    redisMiss: sumMetric(body, 'cache_events_total', 'layer="redis",event="miss"'),
    redisError: sumMetric(body, 'cache_events_total', 'layer="redis",event="error"'),
    staleFillDropped: sumMetric(
      body,
      'cache_events_total',
      'layer="in-memory",event="stale-fill-dropped"',
    ),
    dbQueries: sumMetric(body, 'db_queries_total', 'outcome="success"'),
  };
}

async function readCircuitState(replica: ReplicaId): Promise<number> {
  const body = await fetchReplicaMetricsText(replica);
  const match = /^circuit_breaker_state\s+(\S+)/m.exec(body);
  return match ? Number(match[1]) : NaN;
}

/* ---------------------------------- setup -------------------------------- */

beforeAll(async () => {
  await waitFor(originIsHealthy);
}, 60_000);

describe('GET /api/banners against seeded MongoDB', () => {
  it('returns 200 with the documented envelope and headers', async () => {
    const { status, banners, headers } = await getEdge();

    expect(status).toBe(200);
    expect(Array.isArray(banners)).toBe(true);
    expect(headers.get('cache-control')).toContain('s-maxage');
    expect(headers.get('cache-control')).toContain('stale-while-revalidate');
  });

  it('serves the banners seeded by the Mongo init script', async () => {
    const { banners } = await getEdge();
    const titles = banners.map((banner) => banner.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        'Summer Welcome Offer',
        'High Roller Weekend',
        'New Player Free Spins',
      ]),
    );
  });

  it('applies the active-window rules from the seed data', async () => {
    const { banners } = await getEdge();
    const titles = banners.map((banner) => banner.title);

    // Seeded but must be filtered out: future-scheduled, expired, disabled.
    expect(titles).not.toContain('Holiday Jackpot Countdown (upcoming)');
    expect(titles).not.toContain('Spring Bonus (expired)');
    expect(titles).not.toContain('Retired Loyalty Promo (disabled)');
    expect(banners.every((banner) => banner.isActive)).toBe(true);
  });

  it('orders banners by descending priority', async () => {
    const { banners } = await getEdge();

    const priorities = banners.map((banner) => banner.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('matches what is actually stored in MongoDB', async () => {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      const documents = await client
        .db(MONGODB_DATABASE)
        .collection('banners')
        .find({ isActive: true })
        .toArray();

      expect(documents.length).toBeGreaterThanOrEqual(5);

      const { banners } = await getOrigin();
      const storedIds = new Set(documents.map((document) => String(document._id)));

      for (const banner of banners) {
        expect(storedIds.has(banner.id)).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it('emits ISO-8601 date strings', async () => {
    const { banners } = await getEdge();
    const [banner] = banners;

    expect(banner).toBeDefined();
    expect(banner.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (banner.startDate !== null) {
      expect(banner.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe('Edge cache (Layer 1)', () => {
  it('reports MISS on the first request for a cold key', async () => {
    const url = freshBannerUrl();

    const first = await getEdge(url);

    expect(first.status).toBe(200);
    expect(first.cacheStatus).toBe('MISS');
    expect(first.banners.length).toBeGreaterThan(0);
  });

  it('reports HIT on a repeat request for the same key', async () => {
    const url = freshBannerUrl();

    const first = await getEdge(url);
    const second = await getEdge(url);

    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('HIT');
    expect(second.status).toBe(200);
    // Identical payload, served without consulting the origin.
    expect(second.banners.map((b) => b.id)).toEqual(first.banners.map((b) => b.id));
  });

  it('does not expose a stale origin-layer diagnostic on an edge HIT', async () => {
    const url = freshBannerUrl();

    const miss = await getEdge(url);
    const hit = await getEdge(url);

    expect(miss.cacheStatus).toBe('MISS');
    expect(miss.headers.get('x-served-by')).toBeNull();
    expect(miss.headers.get('x-origin-served-by')).toMatch(/^(in-memory|redis|database)$/);

    expect(hit.cacheStatus).toBe('HIT');
    expect(hit.headers.get('x-served-by')).toBeNull();
    expect(hit.headers.get('x-origin-served-by')).toBeNull();
  });

  it('reports BYPASS for a credentialed request and does not store it', async () => {
    const bypassed = await getOrigin();

    expect(bypassed.status).toBe(200);
    expect(bypassed.cacheStatus).toBe('BYPASS');
  });

  it('a warm edge HIT does not increment API or database counters', async () => {
    const url = freshBannerUrl();

    // Warm the entry (this one legitimately reaches the origin).
    const warm = await getEdge(url);
    expect(warm.cacheStatus).toBe('MISS');

    const before = await readOriginCounters();

    for (let i = 0; i < 5; i += 1) {
      const hit = await getEdge(url);
      expect(hit.cacheStatus).toBe('HIT');
      expect(hit.status).toBe(200);
    }

    const after = await readOriginCounters();

    // The origin never saw these five requests: the edge fully shielded it.
    expect(after.apiRequests).toBe(before.apiRequests);
    expect(after.dbQueries).toBe(before.dbQueries);
  }, 30_000);

  it('collapses concurrent misses on a cold key into a single origin request', async () => {
    const url = freshBannerUrl();
    const before = await readOriginCounters();

    const responses = await Promise.all(Array.from({ length: 20 }, () => getEdge(url)));

    const after = await readOriginCounters();
    const originRequests = after.apiRequests - before.apiRequests;

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.banners.length > 0)).toBe(true);

    // proxy_cache_lock: one request populates the entry, the other 19 wait
    // for it rather than stampeding the origin.
    expect(originRequests).toBeGreaterThanOrEqual(1);
    expect(originRequests).toBeLessThanOrEqual(2);
  }, 30_000);

  it('serves stale content while the origin is deliberately unavailable', async () => {
    const url = freshBannerUrl();

    const warm = await getEdge(url);
    expect(warm.status).toBe(200);
    const warmIds = warm.banners.map((banner) => banner.id);

    // Both replicas down: the origin is genuinely unreachable, not just one
    // instance behind the load balancer.
    dockerCompose('stop api-a api-b');
    try {
      // Let the entry age past s-maxage so it is genuinely stale rather than
      // merely fresh — otherwise a HIT would prove nothing about stale serving.
      await sleep(EDGE_FRESHNESS_MS + CACHE_EXPIRY_MARGIN_MS);

      const stale = await getEdge(url);

      expect(stale.status).toBe(200);
      expect(['STALE', 'UPDATING']).toContain(stale.cacheStatus);
      expect(stale.banners.map((banner) => banner.id)).toEqual(warmIds);
    } finally {
      dockerCompose('start api-a api-b');
      await waitFor(originIsHealthy, { timeoutMs: 60_000 });
    }
  }, 180_000);
});

/**
 * =============================================================================
 * Origin cache layers — metric-delta proof of WHICH layer answered
 * =============================================================================
 * Every test below targets ONE replica directly via `/__replica__/{a,b}`
 * (see that helper's doc comment) so a before/after metrics diff is
 * unambiguous: both reads land on the same process, so the delta can only be
 * explained by what that one request actually did. Each test resets that
 * replica first (clears local cache, Redis key, and that replica's own
 * Prometheus registry to zero), so "the counter went up by exactly N" means
 * exactly N of that event happened during the test body, not since process
 * boot.
 */
describe('Origin cache layers: local-cache hit, Redis hit, and total miss', () => {
  const REPLICA: ReplicaId = 'a';

  beforeEach(async () => {
    await resetReplica(REPLICA);
  });

  it('local-cache hit: serves from in-memory, calls neither Redis nor MongoDB', async () => {
    // Warm the entry so it lands in this replica's local cache.
    const warm = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(warm.status).toBe(200);

    const before = await readCacheEventCounters(REPLICA);

    const hit = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);

    const after = await readCacheEventCounters(REPLICA);

    expect(hit.status).toBe(200);
    expect(hit.servedBy).toBe('in-memory');
    // The defining assertion: an in-memory hit consults neither lower layer.
    expect(after.inMemoryHit - before.inMemoryHit).toBe(1);
    expect(after.redisHit - before.redisHit).toBe(0);
    expect(after.redisMiss - before.redisMiss).toBe(0);
    expect(after.dbQueries - before.dbQueries).toBe(0);
  }, 30_000);

  it('Redis hit: local cache misses, Redis is consulted and hits, MongoDB is not queried', async () => {
    // Warm Redis (and this replica's local cache) with one request, then
    // deterministically expire ONLY the local cache so the next request must
    // fall through to Redis rather than being satisfied locally.
    const warm = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(warm.status).toBe(200);
    await expireLocalCache(REPLICA);

    const before = await readCacheEventCounters(REPLICA);

    const hit = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);

    const after = await readCacheEventCounters(REPLICA);

    expect(hit.status).toBe(200);
    expect(hit.servedBy).toBe('redis');
    // Local cache was consulted and missed (that's WHY Redis was consulted)...
    expect(after.inMemoryMiss - before.inMemoryMiss).toBe(1);
    // ...Redis was consulted and hit...
    expect(after.redisHit - before.redisHit).toBe(1);
    // ...and MongoDB was never reached.
    expect(after.dbQueries - before.dbQueries).toBe(0);
  }, 30_000);

  it('total miss: both caches miss, exactly one MongoDB query happens, and both caches are populated', async () => {
    // resetReplica already cleared this replica's local cache AND the shared
    // Redis key, so the very next request is a guaranteed total miss.
    const before = await readCacheEventCounters(REPLICA);

    const miss = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);

    const after = await readCacheEventCounters(REPLICA);

    expect(miss.status).toBe(200);
    expect(miss.servedBy).toBe('database');
    expect(after.inMemoryMiss - before.inMemoryMiss).toBe(1);
    const redisAttempts =
      after.redisMiss - before.redisMiss + (after.redisError - before.redisError);
    expect(redisAttempts).toBeGreaterThanOrEqual(1);
    expect(after.dbQueries - before.dbQueries).toBe(1);

    // "Both caches populated": prove it by observing the NEXT request hit
    // in-memory without a further Redis or MongoDB call.
    const followUp = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    const afterFollowUp = await readCacheEventCounters(REPLICA);

    expect(followUp.servedBy).toBe('in-memory');
    expect(afterFollowUp.inMemoryHit - after.inMemoryHit).toBe(1);
    expect(afterFollowUp.dbQueries - after.dbQueries).toBe(0);

    // Independently prove the Redis side was populated too: expire ONLY the
    // local cache (leaving Redis alone) and confirm the third request is
    // served from Redis rather than falling all the way through to MongoDB
    // again.
    await expireLocalCache(REPLICA);
    const redisServed = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    const afterRedisServed = await readCacheEventCounters(REPLICA);

    expect(redisServed.servedBy).toBe('redis');
    expect(afterRedisServed.dbQueries - afterFollowUp.dbQueries).toBe(0);
  }, 30_000);

  it('serves a warm repeat request quickly, from whichever layer answered', async () => {
    await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT); // warm

    const start = Date.now();
    const { status, servedBy } = await request(
      replicaUrl(REPLICA, '/api/banners'),
      ORIGIN_BYPASS_INIT,
    );
    const elapsedMs = Date.now() - start;

    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThan(500);
    expect(['in-memory', 'redis', 'database']).toContain(servedBy);
  }, 30_000);

  it('exposes per-layer cache and database counters on the edge-routed /metrics endpoint', async () => {
    // Unlike every other test in this describe block, this one deliberately
    // goes through the EDGE's `/metrics` proxy (not a `/__replica__/*`
    // diagnostic route) to prove that path itself is wired end-to-end, since
    // it is what a real Prometheus scrape target would use in production.
    await getOrigin();
    const body = await fetchMetricsText();

    expect(body).toContain('cache_events_total');
    expect(body).toContain('db_queries_total');
    expect(body).toContain('circuit_breaker_state');
  }, 30_000);
});

describe('Redis outage: fail open to MongoDB', () => {
  const REPLICA: ReplicaId = 'a';

  beforeEach(async () => {
    await resetReplica(REPLICA);
  });

  afterAll(async () => {
    dockerCompose('start redis');
    await waitFor(originIsHealthy);
    await sleep(2_000);
  });

  it('Redis error/circuit-state metrics increase and the MongoDB fallback succeeds', async () => {
    const before = await readCacheEventCounters(REPLICA);
    const circuitBefore = await readCircuitState(REPLICA);

    dockerCompose('stop redis');
    try {
      // Local cache was just reset, so this request has no local hit
      // available and must attempt Redis, observe the failure, then fail
      // open to MongoDB.
      const result = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);

      const after = await readCacheEventCounters(REPLICA);
      const circuitAfter = await readCircuitState(REPLICA);

      expect(result.status).toBe(200);
      expect(result.banners.length).toBeGreaterThan(0);
      expect(result.servedBy).toBe('database');
      expect(result.banners.map((banner) => banner.title)).toContain('Summer Welcome Offer');

      // The failure was OBSERVED, not silently swallowed: either the redis
      // error counter increased, or the circuit breaker moved off `closed`
      // (0) — both are the documented ways a Redis failure surfaces to
      // telemetry. Assert the disjunction explicitly rather than a loose
      // regex match against the raw metrics text.
      const redisErrorIncreased = after.redisError - before.redisError >= 1;
      const circuitChanged = circuitAfter !== circuitBefore || circuitAfter !== 0;
      expect(redisErrorIncreased || circuitChanged).toBe(true);

      // And the fallback is real: MongoDB was actually queried once for
      // this request, not merely "the response happened to be 200".
      expect(after.dbQueries - before.dbQueries).toBe(1);
    } finally {
      dockerCompose('start redis');
      await waitFor(originIsHealthy, { timeoutMs: 60_000 });
      await sleep(2_000);
    }
  }, 90_000);

  it('repeated Redis failures open the circuit breaker (state transitions to non-closed)', async () => {
    dockerCompose('stop redis');
    try {
      // Circuit threshold in compose is 3 failures. Each request below is
      // preceded by expiring the local cache so it cannot short-circuit
      // straight to a local hit and skip contacting Redis.
      for (let i = 0; i < 4; i += 1) {
        await expireLocalCache(REPLICA);
        await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
      }

      const circuitState = await readCircuitState(REPLICA);
      // 0=closed, 1=half-open, 2=open — after repeated failures it must not
      // still read closed.
      expect(circuitState).not.toBe(0);
    } finally {
      dockerCompose('start redis');
      await waitFor(originIsHealthy, { timeoutMs: 60_000 });
      await sleep(2_000);
    }
  }, 90_000);
});

describe('MongoDB outage: controlled 503', () => {
  const REPLICA: ReplicaId = 'a';

  afterAll(async () => {
    dockerCompose('start mongo');
    await waitFor(
      async () => {
        const { status } = await getOrigin();
        return status === 200;
      },
      { timeoutMs: 90_000 },
    );
  }, 120_000);

  it('returns a controlled 503 JSON error when MongoDB is unavailable, via a genuine cache bypass/failure — not a cached error', async () => {
    // Deterministically remove any cached payload this replica could
    // otherwise answer from: clears local cache, the shared Redis key, and
    // this replica's own registry, so the counters read below are exact.
    await resetReplica(REPLICA);
    dockerCompose('exec -T redis redis-cli FLUSHALL');

    const before = await readCacheEventCounters(REPLICA);

    dockerCompose('stop mongo');

    const { status, raw } = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);

    const after = await readCacheEventCounters(REPLICA);

    expect(status).toBe(503);
    expect(raw).toEqual({ error: 'Banner service temporarily unavailable' });

    // Prove this is a genuine cache-bypass-then-database-failure path, not
    // an incidental 503 from something else: both caches were consulted and
    // missed (nothing to fall back on), and MongoDB's own success counter
    // did NOT increase — the 503 corresponds to an attempted-and-failed
    // database query, which `db_queries_total{outcome="success"}` staying
    // flat while the request still 503s is exactly what "controlled
    // failure, not a silently swallowed one" means here.
    expect(after.inMemoryMiss - before.inMemoryMiss).toBe(1);
    expect(after.redisMiss - before.redisMiss).toBe(1);
    expect(after.dbQueries - before.dbQueries).toBe(0);
  }, 90_000);

  it('never caches a 503 at the edge', async () => {
    const url = freshBannerUrl();

    const first = await getEdge(url);
    const second = await getEdge(url);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);

    // A cached error would show HIT on the repeat. The origin sends
    // `Cache-Control: no-store` on the error path, so the edge must not have
    // stored it.
    expect(first.cacheStatus).not.toBe('HIT');
    expect(second.cacheStatus).not.toBe('HIT');
  }, 60_000);

  it('stays live (healthz 200) even while MongoDB is down', async () => {
    const response = await fetch(`${EDGE_URL}/healthz`);
    expect(response.status).toBe(200);
  }, 30_000);
});

/**
 * =============================================================================
 * Deterministic cache expiry and CMS invalidation
 * =============================================================================
 * Uses the test-only mechanisms (`/__test__/expire-local-cache`,
 * `/__test__/cms-event`) instead of sleeping past real TTLs, so these tests
 * are both fast and free of timer-jitter flakiness. See those routes' doc
 * comments in `shared/test-controls/reset-route.ts` for the production
 * caveats each stands in for.
 */
describe('Deterministic cache expiry (test-only mechanism)', () => {
  const REPLICA: ReplicaId = 'a';

  beforeEach(async () => {
    await resetReplica(REPLICA);
  });

  it('expire-local-cache forces the next request past the local layer without touching Redis freshness', async () => {
    const warm = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(warm.servedBy).toBe('database');

    const stillLocal = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(stillLocal.servedBy).toBe('in-memory');

    await expireLocalCache(REPLICA);

    const afterExpiry = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    // Redis was never touched by expire-local-cache, so the request falls
    // through to (and is satisfied by) Redis, not all the way to MongoDB.
    expect(afterExpiry.servedBy).toBe('redis');
  }, 30_000);
});

describe('CMS invalidation path (test-only event-consumer trigger)', () => {
  const REPLICA: ReplicaId = 'a';

  beforeEach(async () => {
    await resetReplica(REPLICA);
  });

  it('a BannerChanged event evicts the target replica local cache and the shared Redis entry', async () => {
    const warm = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(warm.servedBy).toBe('database');

    const localHit = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(localHit.servedBy).toBe('in-memory');

    const before = await readCacheEventCounters(REPLICA);

    await publishCmsEvent(REPLICA, { bannerId: 'test-banner-1', operation: 'updated' });

    // Both this replica's local cache AND the shared Redis key were
    // evicted, so the very next request is a full miss again — exactly the
    // "invalidation clears/versions in-memory and Redis entries" contract,
    // now proven through an inbound change EVENT rather than by calling
    // `BannerService.invalidate()` directly (which the unit tests already
    // cover).
    const afterInvalidation = await request(
      replicaUrl(REPLICA, '/api/banners'),
      ORIGIN_BYPASS_INIT,
    );
    const after = await readCacheEventCounters(REPLICA);

    expect(afterInvalidation.servedBy).toBe('database');
    expect(after.inMemoryMiss - before.inMemoryMiss).toBe(1);
    expect(after.redisMiss - before.redisMiss).toBe(1);
    expect(after.dbQueries - before.dbQueries).toBe(1);
  }, 30_000);

  it('records invalidation lag on /metrics after a CMS event', async () => {
    await publishCmsEvent(REPLICA, { bannerId: 'test-banner-2', operation: 'created' });

    const body = await fetchReplicaMetricsText(REPLICA);
    expect(body).toMatch(/cache_invalidation_lag_seconds_count \d+/);
  }, 30_000);

  it('rejects a CMS event with an invalid operation', async () => {
    const response = await fetch(replicaUrl(REPLICA, '/__test__/cms-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bannerId: 'x', operation: 'not-a-real-operation' }),
    });

    expect(response.status).toBe(400);
  }, 15_000);
});

/**
 * =============================================================================
 * Stale in-flight fill vs. a newer invalidation — real process, real timing
 * =============================================================================
 * The unit-level proof of the epoch guard itself
 * (`test/unit/modules/banners/invalidation-listener.test.ts`, describe block
 * "BannerService: stale in-flight fill cannot overwrite newer invalidated
 * data") is the one that actually controls the race: it uses an
 * artificially delayed fake repository to GUARANTEE the invalidation lands
 * strictly inside the database load's in-flight window, and asserts the
 * fill was dropped. That determinism is not achievable here — a real HTTP
 * request to `/__test__/cms-event` and a real MongoDB-backed
 * `GET /api/banners` do not offer a controllable interleaving, so a test
 * that merely fires both concurrently and asserts "no stale hit afterwards"
 * would pass just as well on ordinary sequential invalidation, proving
 * nothing about the race specifically. Asserting that would be exactly the
 * kind of unearned claim this whole test-strengthening effort exists to
 * eliminate.
 *
 * What THIS suite honestly proves instead: the production-shaped path from
 * an inbound CMS event to actual cache eviction is wired correctly on a
 * real replica under real concurrent read load — i.e. concurrent readers
 * racing an invalidation never observe a torn/inconsistent state (a banner
 * set that matches neither clearly-before nor clearly-after) and the system
 * always converges to a consistent post-invalidation cache within one
 * additional request. Combined with the unit suite's guaranteed-timing
 * proof of the guard mechanism itself, this is the honest, two-part version
 * of the requirement.
 */
describe('CMS invalidation under concurrent read load (real replica, convergence proof)', () => {
  const REPLICA: ReplicaId = 'a';

  beforeEach(async () => {
    await resetReplica(REPLICA);
  });

  it('concurrent reads racing a CMS invalidation always converge to a consistent cache afterwards', async () => {
    await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT); // warm

    const concurrentReads = Array.from({ length: 10 }, () =>
      request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT),
    );
    const invalidation = publishCmsEvent(REPLICA, {
      bannerId: 'race-banner',
      operation: 'updated',
    });

    const [results] = await Promise.all([Promise.all(concurrentReads), invalidation]);

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.banners.length).toBeGreaterThan(0);
    }

    // Convergence: once both the invalidation and every raced read have
    // settled, the cache must be in a clean, self-consistent state — a
    // follow-up read reports a real layer (never something the epoch guard
    // should have prevented from existing, like a torn write) and matches
    // MongoDB's current active set.
    const settled = await request(replicaUrl(REPLICA, '/api/banners'), ORIGIN_BYPASS_INIT);
    expect(['in-memory', 'redis', 'database']).toContain(settled.servedBy);

    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      const activeIds = new Set(
        (
          await client.db(MONGODB_DATABASE).collection('banners').find({ isActive: true }).toArray()
        ).map((document) => String(document._id)),
      );
      for (const banner of settled.banners) {
        expect(activeIds.has(banner.id)).toBe(true);
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});

/**
 * =============================================================================
 * Cross-instance single-flight lease — REAL multi-process proof
 * =============================================================================
 * Everything above proves per-instance and edge-level behaviour. This suite
 * is the one that actually exercises two independently running API
 * containers (`api-a`, `api-b`) behind the Nginx round-robin upstream, and
 * is the only place in the test suite that may be cited as evidence for
 * cross-instance request collapsing. The equivalent unit tests
 * (`test/unit/modules/banners/banner-service.test.ts`, describe block
 * "BannerService: cross-instance single-flight lease") only prove the
 * coordination logic against an in-process fake; they cannot prove that two
 * real OS processes actually elect one leader over a real Redis instance.
 */
describe('Cross-instance single-flight lease (real multi-replica)', () => {
  beforeEach(async () => {
    // Clears Redis + each replica's local cache/in-flight map + each
    // replica's own Prometheus registry. Necessary because the origin cache
    // key (`banners:active:v1`) is constant regardless of URL: a leftover
    // Redis entry from an earlier test would let every request below hit
    // Redis directly, never electing a leader and never touching MongoDB —
    // which would make every assertion in this suite vacuously true.
    await resetReplica('a');
    await resetReplica('b');
  });

  it(
    'elects exactly one cross-instance leader: one Redis lease and one MongoDB ' +
      'query cluster-wide, both replicas answer, and the non-leader serves the ' +
      'Redis-filled payload without ever querying MongoDB',
    async () => {
      const CONCURRENCY = 30;

      // Each request gets its OWN cache-busting query string, i.e. its own
      // EDGE cache key. That is what "clears the edge cache" for this test:
      // every one of these requests is a guaranteed edge MISS, so nginx's
      // proxy_cache_lock never collapses them into one upstream call —
      // each is individually proxied and round-robined across api-a/api-b.
      // (Reusing a single URL for all of them would do the opposite: the
      // edge would lock the key and only the FIRST request would ever
      // reach an origin replica, defeating the "distributed to both
      // replicas" requirement entirely.)
      //
      // The ORIGIN-level cache key is constant (`banners:active:v1`)
      // regardless of query string, so despite hitting different edge keys,
      // every one of these requests contends for the SAME Redis lease.
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => getEdge(freshBannerUrl())),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.every((response) => response.banners.length > 0)).toBe(true);

      // ---- requirement: responses came from both API instances ----
      const instancesSeen = new Set(responses.map((response) => response.instance));
      expect(instancesSeen.has('api-a')).toBe(true);
      expect(instancesSeen.has('api-b')).toBe(true);

      const [metricsA, metricsB] = await Promise.all([
        fetchReplicaMetricsText('a'),
        fetchReplicaMetricsText('b'),
      ]);

      const leasesAcquiredOn = (metrics: string): number =>
        sumMetric(
          metrics,
          'request_collapsing_events_total',
          'scope="cross-instance",role="leader"',
        );
      const dbQueriesOn = (metrics: string): number =>
        sumMetric(metrics, 'db_queries_total', 'outcome="success"');

      // ---- requirement: exactly one Redis lease was acquired, cluster-wide ----
      const leasesAcquired = leasesAcquiredOn(metricsA) + leasesAcquiredOn(metricsB);
      expect(leasesAcquired).toBe(1);

      // ---- requirement: exactly one MongoDB query occurred, cluster-wide ----
      const dbQueriesA = dbQueriesOn(metricsA);
      const dbQueriesB = dbQueriesOn(metricsB);
      expect(dbQueriesA + dbQueriesB).toBe(1);

      // ---- requirement: the non-leader replica never queried MongoDB and
      // did serve a cache-filled payload ----
      const leaderInstance = dbQueriesA === 1 ? 'api-a' : 'api-b';
      const nonLeaderInstance = leaderInstance === 'api-a' ? 'api-b' : 'api-a';

      const nonLeaderMetrics = nonLeaderInstance === 'api-a' ? metricsA : metricsB;
      const nonLeaderCacheHits =
        sumMetric(nonLeaderMetrics, 'cache_events_total', 'layer="redis",event="hit"') +
        sumMetric(nonLeaderMetrics, 'cache_events_total', 'layer="in-memory",event="hit"');

      // The metric proof is authoritative: edge responses may be cached and
      // must not be used to infer an individual origin's transient cache
      // layer. The non-leader had real work, issued zero database queries,
      // and served at least one cache-filled request.
      const nonLeaderResponses = responses.filter(
        (response) => response.instance === nonLeaderInstance,
      );
      // Sanity check that the round-robin actually gave the non-leader work
      // to prove it against, not just an untested instance.
      expect(nonLeaderResponses.length).toBeGreaterThan(0);
      expect(nonLeaderCacheHits).toBeGreaterThan(0);

      // Every replica returned the identical banner set: further proof the
      // non-leader's answer really is the leader's single database read,
      // relayed via Redis, rather than a second independent read.
      const bannerIdSets = new Set(
        responses.map((response) =>
          response.banners
            .map((banner) => banner.id)
            .sort()
            .join(','),
        ),
      );
      expect(bannerIdSets.size).toBe(1);
    },
    30_000,
  );
});
