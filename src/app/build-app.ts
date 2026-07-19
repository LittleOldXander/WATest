import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { BannerService } from '../modules/banners/application/banner-service.js';
import type { InProcessEventBus } from '../modules/banners/infrastructure/events/in-process-event-bus.js';
import { bannerRoutes } from '../modules/banners/presentation/http/banner-routes.js';
import { testControlsRoutes } from '../shared/test-controls/reset-route.js';
import type { Metrics } from '../shared/observability/metrics.js';
import type { ReadinessReport } from './container.js';

export interface BuildAppOptions {
  bannerService: BannerService;
  metrics: Metrics;
  /**
   * Required only when `enableTestControls` is true — backs
   * `POST /__test__/cms-event`. Optional otherwise so production callers
   * never need to construct a test-only fake.
   */
  eventBus?: InProcessEventBus;
  /** Optional dependency probe backing `GET /readyz`. */
  checkReadiness?: () => Promise<ReadinessReport>;
  /** Fastify's own request logging; disabled in tests to keep output clean. */
  logger?: FastifyServerOptions['logger'];
  /**
   * Identifies this process on every response via `X-API-Instance`. With
   * multiple replicas behind the edge, this is how a test (or an operator)
   * proves which instance actually answered a given request.
   */
  instanceId?: string;
  /**
   * Registers `POST /__test__/reset` when true. Defaults to false. This is
   * read once at startup by the caller (see `server.ts` / `app/config.ts`
   * `ENABLE_TEST_CONTROLS`) — there is no in-process way to flip it after
   * the app is built, and no request-time override of any kind.
   */
  enableTestControls?: boolean;
  /** Allows the test-only `cachebust` query parameter without registering test routes. */
  allowTestCacheBust?: boolean;
}

/**
 * Builds the HTTP application by registering module routes plus the
 * cross-cutting operational endpoints. Knows nothing about how dependencies
 * were constructed — that is `container.ts`'s job — which is what makes the
 * app trivially testable with fakes.
 */
export function buildApp({
  bannerService,
  metrics,
  eventBus,
  checkReadiness,
  logger = true,
  instanceId,
  enableTestControls = false,
  allowTestCacheBust = enableTestControls,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    // Fastify's AJV default (`removeAdditional: true`) silently STRIPS
    // properties a schema doesn't declare instead of rejecting them, which
    // would make `additionalProperties: false` on
    // `getActiveBannersQuerystringSchema` a no-op — an unknown query
    // parameter would be dropped rather than rejected with 400. Disabling
    // it here is what makes "reject unknown query parameters" an enforced
    // contract rather than a schema annotation nobody checks.
    ajv: { customOptions: { removeAdditional: false } },
  });

  /**
   * Translates Fastify/AJV schema-validation failures (malformed or unknown
   * query parameters — see `getActiveBannersQuerystringSchema`) into the
   * same controlled `{ error: string }` JSON shape the rest of the API
   * uses, with a `400`. Without this, a validation failure would surface
   * AJV's default shape (`{ statusCode, error, message }` with internal
   * schema-path detail), which is not the documented error contract and can
   * leak implementation detail about the validation library in use.
   *
   * Scoped to validation errors only: anything else re-throws to Fastify's
   * default handling so unexpected errors are not silently reshaped here.
   */
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation && error.validation.length > 0) {
      const [detail] = error.validation;
      const field = typeof detail.instancePath === 'string' ? detail.instancePath : '';
      const message = detail.message ?? 'Invalid request';
      return reply.status(400).send({
        error: field ? `Invalid query parameter${field}: ${message}` : message,
      });
    }
    throw error;
  });

  if (instanceId) {
    app.addHook('onSend', (_request, reply, payload, done) => {
      reply.header('X-API-Instance', instanceId);
      done(null, payload);
    });
  }

  void app.register(bannerRoutes, {
    bannerService,
    metrics,
    allowTestCacheBust,
  });

  // Route is only ever REGISTERED when the flag is true. When false, the
  // plugin call below does not happen at all — `/__test__/reset` 404s
  // exactly as if the route never existed, rather than existing behind a
  // runtime check. See reset-route.ts for the full safety rationale.
  if (enableTestControls) {
    if (!eventBus) {
      throw new Error('enableTestControls requires an eventBus (see BuildAppOptions.eventBus)');
    }
    void app.register(testControlsRoutes, {
      bannerService,
      metrics,
      instanceId: instanceId ?? 'unknown',
      eventBus,
    });
    app.log.warn(
      'ENABLE_TEST_CONTROLS=true: /__test__/reset, /__test__/expire-local-cache, and ' +
        '/__test__/cms-event are active. Do not set this in production.',
    );
  }

  /**
   * Liveness: is the process up? Deliberately does NOT check MongoDB or
   * Redis — the service is designed to stay up and return controlled 503s
   * during a database outage, so a dependency failure must not cause the
   * orchestrator to kill an otherwise healthy container.
   */
  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  /** Readiness: dependency-aware view, for dashboards and debugging. */
  app.get('/readyz', async (_request, reply) => {
    if (!checkReadiness) {
      return reply.status(200).send({ status: 'ok' });
    }
    const dependencies = await checkReadiness();
    const allUp = Object.values(dependencies).every((state) => state === 'up');
    return reply.status(allUp ? 200 : 503).send({
      status: allUp ? 'ok' : 'degraded',
      dependencies,
    });
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', metrics.registry.contentType);
    return reply.send(await metrics.registry.metrics());
  });

  return app;
}
