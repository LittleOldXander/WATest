import { hostname } from 'node:os';
import { cleanEnv, str, num, bool } from 'envalid';

/**
 * Centralized, validated environment configuration.
 *
 * Validation happens once at startup so a malformed value fails fast and
 * loudly, rather than surfacing as an obscure error deep in the request path.
 */
export interface AppConfig {
  port: number;
  nodeEnv: string;
  /** Identifies this replica in logs, metrics, and the `X-API-Instance` response header. */
  instanceId: string;
  /**
   * Enables test-only endpoints (cache/metrics reset) under `/__test__/*`.
   * Defaults to false. Must never be true in a production deployment — see
   * `shared/test-controls` for the full safety rationale.
   */
  enableTestControls: boolean;

  mongodbUri: string;
  mongodbDatabase: string;
  mongodbServerSelectionTimeoutMs: number;
  mongodbMaxPoolSize: number;

  redisUrl: string;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;

  cacheInMemoryTtlMs: number;
  cacheInMemoryMaxItems: number;
  cacheRedisTtlSeconds: number;

  circuitBreakerFailureThreshold: number;
  circuitBreakerResetTimeoutMs: number;

  leaseTtlMs: number;
  leaseWaitTimeoutMs: number;
  leasePollIntervalMs: number;
  leasePollJitterMs: number;

  logLevel: string;
  logPretty: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const validated = cleanEnv(env, {
    PORT: num({ default: 3000 }),
    NODE_ENV: str({ default: 'development' }),
    // Falls back to the hostname (the container ID in Docker) so replicas
    // are still distinguishable if INSTANCE_ID is never explicitly set.
    INSTANCE_ID: str({ default: hostname() }),
    ENABLE_TEST_CONTROLS: bool({ default: false }),

    MONGODB_URI: str({ default: 'mongodb://localhost:27017' }),
    MONGODB_DATABASE: str({ default: 'banners' }),
    // Keep server selection short so an unreachable MongoDB surfaces as a
    // fast, controlled 503 instead of a hanging request.
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: num({ default: 3000 }),
    // Bounded pool: protects MongoDB from connection storms during a Redis
    // outage, when every request falls through to the database.
    MONGODB_MAX_POOL_SIZE: num({ default: 20 }),

    REDIS_URL: str({ default: 'redis://localhost:6379' }),
    REDIS_CONNECT_TIMEOUT_MS: num({ default: 2000 }),
    REDIS_COMMAND_TIMEOUT_MS: num({ default: 500 }),

    CACHE_IN_MEMORY_TTL_MS: num({ default: 5000 }),
    CACHE_IN_MEMORY_MAX_ITEMS: num({ default: 500 }),
    CACHE_REDIS_TTL_SECONDS: num({ default: 30 }),

    CIRCUIT_BREAKER_FAILURE_THRESHOLD: num({ default: 3 }),
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: num({ default: 10000 }),

    LEASE_TTL_MS: num({ default: 5000 }),
    LEASE_WAIT_TIMEOUT_MS: num({ default: 3000 }),
    LEASE_POLL_INTERVAL_MS: num({ default: 100 }),
    LEASE_POLL_JITTER_MS: num({ default: 50 }),

    LOG_LEVEL: str({ default: 'info' }),
    LOG_PRETTY: bool({ default: false }),
  });

  return {
    port: validated.PORT,
    nodeEnv: validated.NODE_ENV,
    instanceId: validated.INSTANCE_ID,
    enableTestControls: validated.ENABLE_TEST_CONTROLS,

    mongodbUri: validated.MONGODB_URI,
    mongodbDatabase: validated.MONGODB_DATABASE,
    mongodbServerSelectionTimeoutMs: validated.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    mongodbMaxPoolSize: validated.MONGODB_MAX_POOL_SIZE,

    redisUrl: validated.REDIS_URL,
    redisConnectTimeoutMs: validated.REDIS_CONNECT_TIMEOUT_MS,
    redisCommandTimeoutMs: validated.REDIS_COMMAND_TIMEOUT_MS,

    cacheInMemoryTtlMs: validated.CACHE_IN_MEMORY_TTL_MS,
    cacheInMemoryMaxItems: validated.CACHE_IN_MEMORY_MAX_ITEMS,
    cacheRedisTtlSeconds: validated.CACHE_REDIS_TTL_SECONDS,

    circuitBreakerFailureThreshold: validated.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    circuitBreakerResetTimeoutMs: validated.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,

    leaseTtlMs: validated.LEASE_TTL_MS,
    leaseWaitTimeoutMs: validated.LEASE_WAIT_TIMEOUT_MS,
    leasePollIntervalMs: validated.LEASE_POLL_INTERVAL_MS,
    leasePollJitterMs: validated.LEASE_POLL_JITTER_MS,

    logLevel: validated.LOG_LEVEL,
    logPretty: validated.LOG_PRETTY,
  };
}
