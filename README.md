# Banner Delivery Service

A Node.js/TypeScript banner API designed for high-volume, read-heavy traffic. It uses cache-aside reads across an Nginx edge-cache emulator, an in-memory LRU, Redis, and MongoDB, with request collapsing and Redis fail-open behaviour.

```
User -> edge-cache emulator -> Fastify replicas -> in-memory LRU -> Redis -> MongoDB
```

The Nginx container is a local emulator of a CDN cache contract; it is not presented as a global CDN. The complete architecture, C4 diagrams, invalidation strategy, and production boundaries are in [DESIGN_DOCUMENT_ARC42.md](./DESIGN_DOCUMENT_ARC42.md).

## Quickstart

Docker Compose is the supported way to run the complete seeded system. It requires only Docker Desktop.

```bash
docker compose up --build
curl -s http://localhost:3000/api/banners
```

`http://localhost:3000` is the Nginx edge. The stack starts two Fastify API replicas, Redis, and a seeded MongoDB instance. Only the edge publishes a host port.

Expected response:

```json
{
  "banners": [
    {
      "id": "0f5f717e-524c-4d3c-8ab7-3cacd2c1b8db",
      "title": "Summer Welcome Offer",
      "imageUrl": "https://cdn.example.com/banners/welcome-summer.png",
      "targetUrl": "https://example.com/promo/welcome-summer",
      "priority": 100,
      "isActive": true,
      "startDate": null,
      "endDate": null,
      "createdAt": "2026-06-19T00:00:00.000Z",
      "updatedAt": "2026-07-17T00:00:00.000Z"
    }
  ]
}
```

Stop the stack with `docker compose down`. Use `docker compose down -v` only when you want MongoDB and Redis reset and MongoDB re-seeded.

### Run without Docker

The application can also run directly with Node.js 20+, provided MongoDB and Redis are already available.

```powershell
npm ci # npm install also works; ci is preferred for the committed lockfile
Copy-Item .env.example .env
# Configure MONGODB_URI and REDIS_URL in .env, then seed MongoDB with docker/mongo-init/001-init-banners.js
npm run dev
```

## API and operational endpoints

| Endpoint           | Purpose                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `GET /api/banners` | Returns active banners ordered by descending priority.                        |
| `GET /healthz`     | Process liveness; remains 200 during dependency outages.                      |
| `GET /readyz`      | Dependency-aware readiness; returns 503 when MongoDB or Redis is unavailable. |
| `GET /metrics`     | Prometheus metrics. Restrict this to internal scraping in a real deployment.  |

`GET /api/banners` returns 400 for unsupported or malformed query parameters, 503 for a known database dependency failure, and 500 for an unexpected server failure. Error responses use `Cache-Control: no-store`.

## Caching and resilience

| Layer           | Behaviour                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge cache      | Nginx honours the origin's `Cache-Control: public, s-maxage=10, stale-while-revalidate=30`, collapses edge misses, and can serve stale content during an origin outage. |
| In-memory cache | Per-replica bounded LRU with a 5-second TTL for zero-network-hop hot reads.                                                                                             |
| Redis           | Shared 30-second cache for cross-replica reuse.                                                                                                                         |
| MongoDB         | Source of truth; queried only after cache misses or Redis degradation.                                                                                                  |

`BannerService` implements cache-aside reads. Concurrent misses are collapsed twice: an in-process promise map coalesces requests on one API replica, then a Redis `SET NX PX` lease coordinates healthy replicas. The lease is released with Redis `EVAL` and a token check, so an expired owner cannot delete a later owner's lease.

If Redis fails, the service logs the error, opens a circuit after repeated failures, and queries MongoDB directly. After cooldown, one half-open probe tests Redis recovery; concurrent requests continue to fail open. If MongoDB is unavailable, the API returns a controlled 503 rather than an incorrect empty banner list.

### Cache invalidation and consistency

A `BannerChanged` event invalidates the receiving API replica's local cache and the shared Redis entry. The prototype uses an in-process event adapter so the behaviour is testable without a CMS. The production integration point is an idempotent durable-outbox consumer or CMS webhook, plus a CDN purge/tag invalidation for changes that must be visible immediately.

This is deliberately eventually consistent: local and edge entries may remain valid until their TTL or purge. The Arc42 document describes the emergency-removal and production broadcast strategy.

## Architecture decisions and trade-offs

- **Repository/data-mapper boundary:** the brief names MongoDB as the legacy database but supplies a PostgreSQL schema. `BannerService` depends on `BannerRepository`, not an ODM, ORM, MongoDB driver, or SQL client. MongoDB is the executable adapter; PostgreSQL can be added without changing business logic or cache policy.
- **Portable CDN contract:** the API emits standard `Cache-Control` headers. Nginx tests the contract locally; CDN cache-key policy, purge, WAF, TLS, origin shielding, and global routing belong to the production platform.
- **Cache-aside rather than write-through:** MongoDB remains the source of truth. A cold key pays one source read, while normal hot reads avoid the database.
- **Local memoization plus Redis coordination:** one avoids same-process stampedes; the other avoids one database read per replica. Redis coordination adds latency only on a cold path.
- **Fail-open cache, fail-closed source:** Redis outages trade latency for availability. MongoDB outages return 503 because no safe source remains.

## Tests and quality checks

```bash
# Unit tests, type checking, linting, and formatting (Docker-only workflow)
docker compose run --rm api-a npm test
docker compose run --rm api-a npm run typecheck
docker compose run --rm api-a npm run lint
docker compose run --rm api-a npm run format:check
```

Integration tests exercise the live edge, both API replicas, Redis, and MongoDB. They stop and restart containers to prove Redis fail-open, MongoDB 503 behaviour, edge caching, stale serving, local memoization, cross-instance request collapsing, and event-driven invalidation.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d --build
npm run test:integration
```

The 5,000 RPS k6 workload includes warm cache, cold cache, local and cross-instance collapsing, and a Redis outage phase:

```bash
npm run test:load
```

On the latest recorded Docker Desktop run, the warm origin-cache phase completed 149,459 successful requests in 30 seconds (approximately 4,982 RPS), with 0 HTTP failures and an overall p95 of 1.64 ms. This is local warm-origin evidence, not a claim about global CDN capacity; the Redis-outage phase is diagnostic and may show dropped scheduled iterations while dependency timeouts occur.

Jest runs in verbose mode so every assertion reads as an executable acceptance criterion. The suites cover:

| Suite                                | What it proves                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit: cache-aside and resilience     | In-memory, Redis, and database fallback paths; TTLs; Redis circuit behaviour; request collapsing; invalidation; and metrics.                                 |
| Unit: HTTP and persistence contracts | JSON response shape, validation, 400/500/503 errors, health/readiness/metrics endpoints, MongoDB query mapping, and active-window rules.                     |
| Integration: Docker stack            | Edge MISS/HIT/stale responses, origin cache layers, Redis fail-open, MongoDB 503, real Mongo indexes, two-replica single-flight, and CMS-event invalidation. |
| Load: k6                             | Sustained warm-cache traffic, cold paths, concurrent expiry, cross-instance coordination, and Redis-outage degradation.                                      |

## Observability

`/metrics` provides request rate, latency histograms, HTTP errors, per-layer cache events, database query count and latency, Redis circuit state, request-collapsing leaders/waiters, cache-fill timing, invalidation lag, and standard Node.js runtime metrics (event-loop lag, heap, CPU, and GC).

Use the metrics to alert on rising p95/p99 latency, declining cache-hit rate, Redis errors/circuit openings, database-query growth, invalidation lag, and event-loop pressure before users are affected.

## Authentication

Banner reads are public and cacheable by default. In production, a CDN or API gateway performs rate limiting and, where the response is tenant-specific, validates a JWT or signed session before forwarding verified identity context. The API must never trust a client-supplied tenant header. CMS write operations require an authenticated admin boundary, role-based access control, audit logging, and secrets from a secret manager.

## Project structure

```text
src/
  app/                         composition root and Fastify assembly
  modules/banners/
    domain/                    Banner and BannerRepository port
    application/               BannerService, cache keys, invalidation port
    infrastructure/            MongoDB, Redis, LRU, and event adapters
    presentation/http/         route, schemas, and response mapping
  shared/                      errors, metrics, logging, circuit breaker
test/
  unit/                        isolated service and adapter tests
  integration/                 Docker Compose end-to-end tests
  load/                        k6 workload and saved result
```

## Further reading

- [Arc42 architectural design document](./DESIGN_DOCUMENT_ARC42.md)
- [Docker Compose configuration](./docker-compose.yml)
- [Environment variable template](./.env.example)
