import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { BannerService } from '../../modules/banners/application/banner-service.js';
import type { InProcessEventBus } from '../../modules/banners/infrastructure/events/in-process-event-bus.js';
import type { Metrics } from '../observability/metrics.js';

export interface TestControlsOptions {
  bannerService: BannerService;
  metrics: Metrics;
  instanceId: string;
  /**
   * The in-process fake CMS event bus for this instance. Only present so
   * `POST /__test__/cms-event` can publish to it — see that route below and
   * `EventConsumer`'s doc comment for why this is a test/dev fake rather
   * than a real outbox consumer.
   */
  eventBus: InProcessEventBus;
}

interface CmsEventRequestBody {
  bannerId?: unknown;
  operation?: unknown;
}

const VALID_OPERATIONS = new Set(['created', 'updated', 'deleted']);

/**
 * Test-only reset endpoint: `POST /__test__/reset`.
 *
 * =============================================================================
 * WHY THIS IS SAFE TO SHIP IN THE IMAGE, AND WHY IT STILL CANNOT RUN IN PROD
 * =============================================================================
 * The route body is only ever REGISTERED when `ENABLE_TEST_CONTROLS=true` is
 * read at startup (see `registerTestControls` below and `app/build-app.ts`).
 * There is no header, token, or query parameter that flips this on at
 * request time — the only way to reach this handler is for the process to
 * have booted with that environment variable set. That is deliberate:
 *
 *   - The production Dockerfile stage never sets ENABLE_TEST_CONTROLS, and
 *     docker-compose.yml only sets it on the `api-a`/`api-b` (development
 *     target) services used for local dev and integration tests.
 *   - Because the flag is read once at process start, there is no runtime
 *     toggle an attacker (or a misrouted request) could flip to enable it.
 *   - When the flag is false, this file's route is simply never registered:
 *     the path 404s exactly as if it never existed, rather than existing
 *     but rejecting requests. There is nothing to probe or bypass.
 *
 * What it does when enabled:
 *   1. Clears this instance's local in-memory (Layer 2) cache.
 *   2. Deletes the shared Redis banner cache key and any lease lock still
 *      held by this instance for it (best-effort: a lock naturally expires
 *      anyway, this just avoids waiting out the TTL between test runs).
 *   3. Resets every Prometheus counter/histogram in this process's registry,
 *      so a test's "exactly one X happened" assertion measures only what
 *      happened during that test, not everything since process boot.
 *   4. Closes the Redis circuit breaker, so a prior outage test cannot make
 *      the next test silently bypass Redis during deterministic setup.
 *
 * It intentionally does NOT touch MongoDB data — resetting seed data is
 * out of scope for a cache/metrics reset and would make tests slower and
 * order-dependent for no benefit.
 */
export const testControlsRoutes: FastifyPluginAsync<TestControlsOptions> = async (
  app: FastifyInstance,
  { bannerService, metrics, instanceId, eventBus }: TestControlsOptions,
) => {
  app.post('/__test__/reset', async (_request, reply) => {
    await bannerService.resetForTesting();
    metrics.registry.resetMetrics();

    app.log.warn(
      { instanceId },
      'Test controls: cache and metrics reset (ENABLE_TEST_CONTROLS=true)',
    );

    return reply.status(200).send({ status: 'reset', instanceId });
  });

  /**
   * Test-only: deterministically expire this instance's local (Layer 2)
   * cache entry without waiting out CACHE_IN_MEMORY_TTL_MS. See
   * `BannerService.expireLocalCacheForTesting`.
   */
  app.post('/__test__/expire-local-cache', async (_request, reply) => {
    bannerService.expireLocalCacheForTesting();
    return reply.status(200).send({ status: 'local-cache-expired', instanceId });
  });

  /**
   * Test-only: publish a fake `BannerChanged` CMS event to this instance's
   * in-process event bus and wait for `InvalidationListener` to finish
   * handling it (i.e. for `bannerService.invalidate()` to resolve) before
   * responding. This is what makes the invalidation integration tests
   * deterministic: they get a synchronous "invalidation has definitely
   * happened" signal instead of polling or sleeping.
   *
   * This proves the invalidation *contract* the same way `/__test__/reset`
   * proves cache-reset behaviour — through code that actually runs, not a
   * document. It does not prove durable cross-process event delivery from a
   * real CMS; that remains the documented production integration point (see
   * `EventConsumer`'s doc comment).
   */
  app.post<{ Body: CmsEventRequestBody }>('/__test__/cms-event', async (request, reply) => {
    const { bannerId, operation } = request.body;

    if (typeof bannerId !== 'string' || bannerId.length === 0) {
      return reply.status(400).send({ error: 'bannerId must be a non-empty string' });
    }
    if (typeof operation !== 'string' || !VALID_OPERATIONS.has(operation)) {
      return reply
        .status(400)
        .send({ error: 'operation must be one of created, updated, deleted' });
    }

    const occurredAt = new Date();
    await eventBus.publish({
      bannerId,
      operation: operation as 'created' | 'updated' | 'deleted',
      occurredAt,
    });

    app.log.warn(
      { instanceId, bannerId, operation },
      'Test controls: fake CMS event published (ENABLE_TEST_CONTROLS=true)',
    );

    return reply.status(200).send({ status: 'invalidated', instanceId, bannerId, operation });
  });
};
