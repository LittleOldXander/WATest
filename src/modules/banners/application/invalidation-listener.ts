import type { BannerService } from './banner-service.js';
import type { Logger } from '../../../shared/observability/logger.js';

/**
 * A CMS write (create/update/delete) that should invalidate cached banner
 * data. In production this is the payload of a `BannerChanged` domain event
 * published by the CMS's transactional outbox — see the module doc comment
 * below for exactly where the real integration point is.
 */
export interface BannerChangeEvent {
  /** ID of the banner that changed. Informational only today: the cache key
   * this service invalidates is a single collection-wide key, not per-banner,
   * so every change event evicts the same key regardless of which banner
   * triggered it. Carried through so a future per-key invalidation scheme
   * (see DESIGN_DOCUMENT_ARC42.md "cache-key strategy") has it available
   * without an interface change. */
  bannerId: string;
  /** What happened to the banner. */
  operation: 'created' | 'updated' | 'deleted';
  /** When the CMS committed the change, per the outbox record — used to
   * compute `cache_invalidation_lag_seconds`. */
  occurredAt: Date;
}

/**
 * Outbound port: something that can notify this process a `BannerChanged`
 * event arrived. `BannerService` and every route/adapter deal only in this
 * interface, never in a specific transport.
 *
 * ---------------------------------------------------------------------------
 * PRODUCTION INTEGRATION POINT
 * ---------------------------------------------------------------------------
 * The real implementation of this port is NOT included here and is
 * explicitly out of scope for this prototype. A production deployment would
 * implement it as one of:
 *
 *   - A consumer of a durable outbox relay (e.g. Debezium/CDC on the CMS's
 *     outbox table -> Kafka/SNS/SQS -> a consumer that calls `onBannerChanged`).
 *   - A webhook receiver the CMS calls synchronously after commit.
 *
 * Either way the consumer MUST be idempotent (the same `BannerChanged` event
 * may be delivered more than once) and should acknowledge/commit its offset
 * only after `BannerService.invalidate()` resolves, so a crash mid-processing
 * re-delivers rather than silently drops the event. `InProcessEventBus` (see
 * `infrastructure/events/in-process-event-bus.ts`) is a same-process fake
 * standing in for that consumer in dev/tests: it proves the invalidation
 * *contract* — cache eviction wired to an inbound change event — without
 * claiming to prove durable cross-process delivery, which is a production
 * concern (outbox table + relay + consumer offsets) that a single-process
 * prototype cannot meaningfully exercise.
 */
export interface EventConsumer {
  /** Register a handler to run for every delivered `BannerChanged` event. */
  onBannerChanged(handler: (event: BannerChangeEvent) => Promise<void> | void): void;
}

/**
 * Wires an `EventConsumer` to `BannerService.invalidate()`.
 *
 * Kept as a thin, separately testable class (rather than inlined into
 * `container.ts`) so the "a change event evicts both cache layers" behaviour
 * has its own unit tests independent of the transport, and so a future
 * per-banner invalidation strategy has one obvious place to grow into.
 */
export class InvalidationListener {
  public constructor(
    private readonly consumer: EventConsumer,
    private readonly bannerService: BannerService,
    private readonly logger: Logger,
  ) {
    this.consumer.onBannerChanged((event) => this.handle(event));
  }

  private async handle(event: BannerChangeEvent): Promise<void> {
    try {
      await this.bannerService.invalidate(event.occurredAt);
      this.logger.info(
        { bannerId: event.bannerId, operation: event.operation },
        'Cache invalidated for banner change event',
      );
    } catch (error) {
      // invalidate() already swallows a Redis-delete failure internally (TTL
      // is the safety net there); anything that escapes to here is
      // unexpected. Log and move on rather than crash the consumer loop —
      // a dropped invalidation degrades to "stale until TTL expiry", which
      // is the documented bounded-eventual-consistency behaviour, not a
      // correctness violation.
      this.logger.error(
        { err: error, bannerId: event.bannerId, operation: event.operation },
        'Failed to handle banner change event',
      );
    }
  }
}
