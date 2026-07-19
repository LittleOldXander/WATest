import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import {
  BannerService,
  type CachedBannerPayload,
} from '../modules/banners/application/banner-service.js';
import { InvalidationListener } from '../modules/banners/application/invalidation-listener.js';
import { InMemoryBannerCache } from '../modules/banners/infrastructure/cache/in-memory-banner-cache.js';
import { RedisBannerCache } from '../modules/banners/infrastructure/cache/redis-banner-cache.js';
import { RedisSingleFlight } from '../modules/banners/infrastructure/cache/redis-single-flight.js';
import { InProcessEventBus } from '../modules/banners/infrastructure/events/in-process-event-bus.js';
import { MongoBannerRepository } from '../modules/banners/infrastructure/persistence/mongo-banner-repository.js';
import { createLogger, type Logger } from '../shared/observability/logger.js';
import { Metrics } from '../shared/observability/metrics.js';
import { CircuitBreaker } from '../shared/resilience/circuit-breaker.js';
import { loadConfig, type AppConfig } from './config.js';

export interface Container {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  bannerService: BannerService;
  mongoClient: MongoClient;
  redisClient: Redis;
  /**
   * CMS change-event bus. A same-process fake in every environment this
   * container builds (dev, integration tests) — see
   * `infrastructure/events/in-process-event-bus.ts` for why a real
   * outbox/Kafka/SQS consumer is out of scope here. Exposed on the
   * container so the test-only `/__test__/cms-event` route can publish to
   * it directly.
   */
  eventBus: InProcessEventBus;
  /** Dependency probe for readiness checks. */
  checkReadiness(): Promise<ReadinessReport>;
  shutdown(): Promise<void>;
}

export interface ReadinessReport {
  mongo: 'up' | 'down';
  redis: 'up' | 'down';
}

/**
 * Composition root: the single place that knows about concrete
 * implementations (MongoDB driver, ioredis, LRU cache).
 *
 * Everything inward of this file depends only on ports, which is what keeps
 * `BannerService` free of MongoDB, Redis, and Fastify imports.
 */
export async function createContainer(config: AppConfig = loadConfig()): Promise<Container> {
  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });
  const metrics = new Metrics();

  /* ----------------------------- MongoDB ---------------------------------- */

  const mongoClient = new MongoClient(config.mongodbUri, {
    serverSelectionTimeoutMS: config.mongodbServerSelectionTimeoutMs,
    maxPoolSize: config.mongodbMaxPoolSize,
  });

  // Connect eagerly for a fast, clear startup signal — but do NOT let a
  // MongoDB outage prevent the process from starting. The driver keeps
  // retrying in the background; meanwhile queries fail fast and the HTTP
  // layer returns a controlled 503, which is the required behavior.
  await mongoClient.connect().catch((error: unknown) => {
    logger.error(
      { err: error, uri: redactCredentials(config.mongodbUri) },
      'Initial MongoDB connection failed; API will start and return 503 until it recovers',
    );
  });

  const db = mongoClient.db(config.mongodbDatabase);
  const repository = new MongoBannerRepository(db);

  /* ------------------------------ Redis ----------------------------------- */

  const redisClient = new Redis(config.redisUrl, {
    connectTimeout: config.redisConnectTimeoutMs,
    commandTimeout: config.redisCommandTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    lazyConnect: false,
  });

  // A Redis outage is survivable by design: log it and let the service fail
  // open to MongoDB. Without this handler ioredis would emit an unhandled
  // 'error' event and crash the process.
  redisClient.on('error', (error: unknown) => {
    logger.warn({ err: error }, 'Redis connection error (service will fail open to MongoDB)');
  });

  const cache = new RedisBannerCache(redisClient);
  const singleFlight = new RedisSingleFlight(redisClient, logger, {
    leaseTtlMs: config.leaseTtlMs,
    waitTimeoutMs: config.leaseWaitTimeoutMs,
    pollIntervalMs: config.leasePollIntervalMs,
    pollJitterMs: config.leasePollJitterMs,
  });

  /* ---------------------------- Application ------------------------------- */

  const bannerService = new BannerService({
    repository,
    cache,
    localCache: new InMemoryBannerCache<CachedBannerPayload>(
      config.cacheInMemoryMaxItems,
      config.cacheInMemoryTtlMs,
    ),
    singleFlight,
    circuitBreaker: new CircuitBreaker(
      config.circuitBreakerFailureThreshold,
      config.circuitBreakerResetTimeoutMs,
    ),
    logger,
    options: {
      cacheTtlSeconds: config.cacheRedisTtlSeconds,
      localCacheTtlMs: config.cacheInMemoryTtlMs,
    },
    metrics,
  });

  /* ------------------------- CMS invalidation path ------------------------- */

  const eventBus = new InProcessEventBus();
  // Its constructor registers the handler (eventBus -> bannerService.invalidate())
  // as a side effect; the instance itself is not otherwise referenced. See
  // InvalidationListener / EventConsumer doc comments for the production
  // integration point this stands in for.
  void new InvalidationListener(eventBus, bannerService, logger);

  return {
    config,
    logger,
    metrics,
    bannerService,
    mongoClient,
    redisClient,
    eventBus,

    async checkReadiness(): Promise<ReadinessReport> {
      const [mongo, redis] = await Promise.all([
        mongoClient
          .db(config.mongodbDatabase)
          .command({ ping: 1 })
          .then(() => 'up' as const)
          .catch(() => 'down' as const),
        redisClient
          .ping()
          .then(() => 'up' as const)
          .catch(() => 'down' as const),
      ]);
      return { mongo, redis };
    },

    async shutdown(): Promise<void> {
      await mongoClient.close().catch((error: unknown) => {
        logger.warn({ err: error }, 'Error closing MongoDB client');
      });
      redisClient.disconnect();
    },
  };
}

/** Strips user:password from a connection string before logging it. */
function redactCredentials(uri: string): string {
  return uri.replace(/\/\/[^@]*@/, '//***:***@');
}
