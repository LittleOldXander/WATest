import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const ORIGIN_BASE_URL = __ENV.ORIGIN_BASE_URL || 'http://api-a:3000';
const EDGE_BASE_URL = __ENV.EDGE_BASE_URL || 'http://edge';

const errors = new Counter('errors');
const originInMemory = new Counter('origin_served_by_in_memory');
const originRedis = new Counter('origin_served_by_redis');
const originDatabase = new Counter('origin_served_by_database');
const edgeHit = new Counter('edge_cache_hit');
const edgeMiss = new Counter('edge_cache_miss');
const edgeBypass = new Counter('edge_cache_bypass');
const instancesA = new Counter('api_a_responses');
const instancesB = new Counter('api_b_responses');
const latencyTrend = new Trend('banner_request_duration', true);

export const options = {
  scenarios: {
    // Sustained 5,000-RPS origin benchmark. The in-memory cache should absorb
    // nearly all requests after the first load.
    warm_cache: {
      executor: 'constant-arrival-rate',
      exec: 'warmCache',
      rate: 5000,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      startTime: '0s',
    },
    // The harness resets both caches immediately before this phase.
    cold_cache: {
      executor: 'constant-arrival-rate',
      exec: 'coldCache',
      rate: 2000,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 200,
      maxVUs: 500,
      startTime: '35s',
    },
    // One replica: verifies local promise memoization under a cold burst.
    concurrent_expiry: {
      executor: 'per-vu-iterations',
      exec: 'concurrentExpiry',
      vus: 300,
      iterations: 1,
      startTime: '50s',
      maxDuration: '15s',
    },
    // An Authorization header bypasses edge reads and writes, forcing the
    // burst through round-robin to both replicas and exercising the Redis
    // lease without polluting the shared edge-cache key space.
    cross_instance_expiry: {
      executor: 'per-vu-iterations',
      exec: 'crossInstanceExpiry',
      vus: 300,
      iterations: 1,
      startTime: '70s',
      maxDuration: '15s',
    },
    // Redis is stopped by the harness immediately before this phase.
    redis_unavailable: {
      executor: 'constant-arrival-rate',
      exec: 'redisUnavailable',
      rate: 1000,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 100,
      // Redis command timeouts can briefly occupy a worker before the
      // circuit opens. Keep enough headroom to observe the fail-open path
      // without artificially capping the arrival-rate executor at 300 VUs.
      maxVUs: 1000,
      startTime: '90s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1000'],
    // Threshold rates are calculated over the WHOLE multi-phase run, not a
    // scenario's own 30-second duration. Count is therefore the correct
    // assertion for the warm 5,000-RPS phase: 145,000 / 30s = 4,833 RPS,
    // leaving a small scheduler-jitter allowance below the configured rate.
    'http_reqs{scenario:warm_cache}': ['count>145000'],
  },
};

function recordResponse(res) {
  const ok = check(res, { 'status is 200': (response) => response.status === 200 });
  if (!ok) errors.add(1);

  latencyTrend.add(res.timings.duration);

  const servedBy = res.headers['X-Origin-Served-By'] || res.headers['X-Served-By'];
  if (servedBy === 'in-memory') originInMemory.add(1);
  else if (servedBy === 'redis') originRedis.add(1);
  else if (servedBy === 'database') originDatabase.add(1);

  const cacheStatus = res.headers['X-Cache-Status'];
  if (cacheStatus === 'HIT') edgeHit.add(1);
  else if (cacheStatus === 'MISS') edgeMiss.add(1);
  else if (cacheStatus === 'BYPASS') edgeBypass.add(1);

  if (res.headers['X-API-Instance'] === 'api-a') instancesA.add(1);
  if (res.headers['X-API-Instance'] === 'api-b') instancesB.add(1);
}

function callOrigin() {
  const res = http.get(`${ORIGIN_BASE_URL}/api/banners`);
  recordResponse(res);
}

function callCrossInstanceEdge() {
  const res = http.get(`${EDGE_BASE_URL}/api/banners`, {
    headers: { Authorization: 'Bearer k6-cross-instance-bypass' },
  });
  recordResponse(res);
}

export function warmCache() {
  callOrigin();
}

export function coldCache() {
  callOrigin();
}

export function concurrentExpiry() {
  callOrigin();
}

export function crossInstanceExpiry() {
  callCrossInstanceEdge();
}

export function redisUnavailable() {
  callOrigin();
  sleep(0.01);
}
