import type { Banner } from '../../domain/banner.js';

/**
 * Wire format for a banner.
 *
 * Dates are emitted as ISO-8601 strings. The route maps domain `Date`s to
 * strings explicitly (see `toBannerResponse`) rather than relying on the
 * serializer's date handling, which keeps the JSON byte-identical to the
 * previous `JSON.stringify` behavior and keeps the API contract stable.
 */
export interface BannerResponse {
  id: string;
  title: string;
  imageUrl: string;
  targetUrl: string;
  priority: number;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toBannerResponse(banner: Banner): BannerResponse {
  return {
    id: banner.id,
    title: banner.title,
    imageUrl: banner.imageUrl,
    targetUrl: banner.targetUrl,
    priority: banner.priority,
    isActive: banner.isActive,
    startDate: banner.startDate ? banner.startDate.toISOString() : null,
    endDate: banner.endDate ? banner.endDate.toISOString() : null,
    createdAt: banner.createdAt.toISOString(),
    updatedAt: banner.updatedAt.toISOString(),
  };
}

const bannerJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    imageUrl: { type: 'string' },
    targetUrl: { type: 'string' },
    priority: { type: 'integer' },
    isActive: { type: 'boolean' },
    startDate: { type: ['string', 'null'] },
    endDate: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'id',
    'title',
    'imageUrl',
    'targetUrl',
    'priority',
    'isActive',
    'startDate',
    'endDate',
    'createdAt',
    'updatedAt',
  ],
} as const;

const errorJsonSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} as const;

/**
 * Supported query parameters for `GET /api/banners`.
 *
 * `cachebust` is a test-only opaque UUID used by the integration suite to
 * obtain a deliberately cold edge-cache key without a cache purge. It is
 * accepted only when `ENABLE_TEST_CONTROLS=true`; production rejects it,
 * preventing a public unbounded-cardinality cache key from being created.
 *
 * `additionalProperties: false` on the querystring schema means any
 * parameter not listed here is rejected with 400, not silently ignored —
 * silently ignoring unknown parameters would hide typos and let an
 * un-validated parameter accidentally influence caching or downstream
 * behaviour without ever being reviewed here.
 */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const testQuerystringSchema = {
  type: 'object',
  properties: {
    cachebust: {
      type: 'string',
      pattern: UUID_PATTERN,
      description: 'Opaque UUID used only to vary the edge cache key. Never read by the API.',
    },
  },
  additionalProperties: false,
} as const;

const productionQuerystringSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

/** Response schemas for `GET /api/banners`, used by Fastify's serializer. */
export function getActiveBannersSchema(allowTestCacheBust: boolean) {
  return {
    querystring: allowTestCacheBust ? testQuerystringSchema : productionQuerystringSchema,
    response: {
      200: {
        type: 'object',
        properties: {
          banners: { type: 'array', items: bannerJsonSchema },
        },
        required: ['banners'],
      },
      400: errorJsonSchema,
      500: errorJsonSchema,
      503: errorJsonSchema,
    },
  } as const;
}
