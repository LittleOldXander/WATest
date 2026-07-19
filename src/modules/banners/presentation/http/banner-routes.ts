import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { BannerService } from '../../application/banner-service.js';
import { ApplicationError } from '../../../../shared/errors/application-error.js';
import type { Metrics } from '../../../../shared/observability/metrics.js';
import { getActiveBannersSchema, toBannerResponse } from './banner-schemas.js';

const ROUTE = '/api/banners';

/**
 * CDN / edge layer (Layer 1): a short freshness window plus a longer
 * stale-while-revalidate, so edge nodes can serve slightly stale content
 * while revalidating instead of all missing to origin in lockstep.
 */
const CACHE_CONTROL_HEADER = 'public, max-age=10, s-maxage=10, stale-while-revalidate=30';

export interface BannerRoutesOptions {
  bannerService: BannerService;
  metrics: Metrics;
  allowTestCacheBust: boolean;
}

/**
 * All Fastify-specific concerns for the banners module live here: routing,
 * headers, status codes, serialization schemas, and error translation.
 * The application layer stays framework-agnostic.
 */
export const bannerRoutes: FastifyPluginAsync<BannerRoutesOptions> = async (
  app: FastifyInstance,
  { bannerService, metrics, allowTestCacheBust }: BannerRoutesOptions,
) => {
  app.get(
    ROUTE,
    { schema: getActiveBannersSchema(allowTestCacheBust) },
    async (_request, reply) => {
      const routeStart = process.hrtime.bigint();

      try {
        const outcome = await bannerService.getActiveBanners();

        reply.header('Cache-Control', CACHE_CONTROL_HEADER);
        reply.header('X-Served-By', outcome.servedBy);

        const statusCode = 200;
        metrics.httpRequestsTotal.inc({ route: ROUTE, method: 'GET', status_code: statusCode });
        observeDuration(metrics, routeStart, ROUTE, 'GET', statusCode);

        return await reply
          .status(statusCode)
          .send({ banners: outcome.banners.map(toBannerResponse) });
      } catch (error) {
        app.log.error({ err: error }, 'Unable to retrieve banners');

        const knownDependencyFailure = error instanceof ApplicationError;
        const statusCode = knownDependencyFailure ? 503 : 500;
        metrics.httpRequestsTotal.inc({ route: ROUTE, method: 'GET', status_code: statusCode });
        metrics.httpErrorsTotal.inc({ route: ROUTE });
        observeDuration(metrics, routeStart, ROUTE, 'GET', statusCode);

        // Known application failures (e.g. MongoDB unreachable) get a stable,
        // caller-safe message; anything else is reported generically so driver
        // internals never leak.
        const message = knownDependencyFailure
          ? 'Banner service temporarily unavailable'
          : 'Internal server error';

        reply.header('Cache-Control', 'no-store');
        return await reply.status(statusCode).send({ error: message });
      }
    },
  );
};

function observeDuration(
  metrics: Metrics,
  start: bigint,
  route: string,
  method: string,
  statusCode: number,
): void {
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  metrics.httpRequestDuration.observe({ route, method, status_code: statusCode }, seconds);
}
