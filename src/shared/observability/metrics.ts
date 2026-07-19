import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { CircuitState } from '../resilience/circuit-breaker.js';

/**
 * Central Prometheus-style metrics registry, exposed via GET /metrics.
 *
 * Covers every signal called out in the build brief: request rate/latency/
 * errors, per-layer cache hit/miss/error, circuit-breaker state, database
 * query count/latency, request-collapsing leader/waiter counts, cache-fill
 * time, invalidation lag, and Node.js runtime health (event-loop lag, heap,
 * CPU, GC) via collectDefaultMetrics.
 */
export class Metrics {
  public readonly registry = new Registry();

  public readonly httpRequestDuration: Histogram;
  public readonly httpRequestsTotal: Counter;
  public readonly httpErrorsTotal: Counter;

  public readonly cacheEventsTotal: Counter;
  public readonly circuitBreakerState: Gauge;

  public readonly dbQueriesTotal: Counter;
  public readonly dbQueryDuration: Histogram;

  public readonly collapsingEventsTotal: Counter;
  public readonly cacheFillDuration: Histogram;
  public readonly invalidationLag: Histogram;

  public constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['route', 'method', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['route', 'method', 'status_code'],
      registers: [this.registry],
    });

    this.httpErrorsTotal = new Counter({
      name: 'http_errors_total',
      help: 'Total HTTP error responses (5xx)',
      labelNames: ['route'],
      registers: [this.registry],
    });

    this.cacheEventsTotal = new Counter({
      name: 'cache_events_total',
      help: 'Cache hit/miss/error events per layer',
      labelNames: ['layer', 'event'], // layer: in-memory|redis ; event: hit|miss|error
      registers: [this.registry],
    });

    this.circuitBreakerState = new Gauge({
      name: 'circuit_breaker_state',
      help: 'Redis circuit breaker state (0=closed, 1=half-open, 2=open)',
      registers: [this.registry],
    });

    this.dbQueriesTotal = new Counter({
      name: 'db_queries_total',
      help: 'Total database queries executed',
      labelNames: ['outcome'], // outcome: success|error
      registers: [this.registry],
    });

    this.dbQueryDuration = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Database query duration in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.collapsingEventsTotal = new Counter({
      name: 'request_collapsing_events_total',
      help: 'Request collapsing leader/waiter counts at each level',
      // scope: local|cross-instance ; role: leader|waiter
      //   local:leader        -> this instance won the in-process promise race
      //   local:waiter        -> this instance awaited another in-flight
      //                          request on this same instance
      //   cross-instance:leader -> this instance acquired the Redis lease and
      //                          queried the database
      //   cross-instance:waiter -> this instance lost the Redis lease and
      //                          waited on another replica
      labelNames: ['scope', 'role'],
      registers: [this.registry],
    });

    this.cacheFillDuration = new Histogram({
      name: 'cache_fill_duration_seconds',
      help: 'Time to populate Redis + in-memory cache after a database load',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [this.registry],
    });

    this.invalidationLag = new Histogram({
      name: 'cache_invalidation_lag_seconds',
      help: 'Time between a CMS write event and cache eviction/version bump',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  public recordCircuitState(state: CircuitState): void {
    const value = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
    this.circuitBreakerState.set(value);
  }
}
