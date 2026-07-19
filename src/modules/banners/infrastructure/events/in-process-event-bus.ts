import type { BannerChangeEvent, EventConsumer } from '../../application/invalidation-listener.js';

/**
 * Same-process fake standing in for a real outbox-relay/Kafka/SQS consumer.
 *
 * This is deliberately NOT a production adapter. It exists so:
 *   1. `InvalidationListener` has something real to wire to in dev and in
 *      the Docker Compose integration stack.
 *   2. The test-only `/__test__/cms-event` route (see
 *      `shared/test-controls/reset-route.ts`) has a way to synchronously
 *      inject a `BannerChanged` event and deterministically await its
 *      handling, which is what makes the invalidation tests deterministic
 *      instead of racy.
 *
 * A production deployment replaces this whole class with a real consumer —
 * see the "PRODUCTION INTEGRATION POINT" doc comment on `EventConsumer` for
 * what that involves (durable delivery, idempotency, offset commits). Swap
 * it in at the `EventConsumer` port in `container.ts`; nothing above that
 * port needs to change.
 */
export class InProcessEventBus implements EventConsumer {
  private handlers: ((event: BannerChangeEvent) => Promise<void> | void)[] = [];

  public onBannerChanged(handler: (event: BannerChangeEvent) => Promise<void> | void): void {
    this.handlers.push(handler);
  }

  /**
   * Publish an event to every registered handler and wait for all of them.
   * Real event-bus consumers do not offer a synchronous "wait for handling"
   * primitive to the publisher — this one does, deliberately, so tests can
   * assert on invalidation effects without polling or sleeping.
   */
  public async publish(event: BannerChangeEvent): Promise<void> {
    // Handlers may be sync or async (`Promise<void> | void`); wrap each call
    // so `Promise.all` always aggregates real promises rather than a mix of
    // promises and plain values.
    await Promise.all(this.handlers.map(async (handler) => handler(event)));
  }
}
