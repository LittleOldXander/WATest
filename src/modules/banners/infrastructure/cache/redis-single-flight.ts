import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  SingleFlightCoordinator,
  SingleFlightLease,
} from '../../application/banner-service.js';
import { bannerLockKey, bannerReadyChannel } from '../../application/banner-cache-keys.js';
import type { Logger } from '../../../../shared/observability/logger.js';

/**
 * Atomic, token-safe lock release: only delete the key if its value still
 * matches the caller's token.
 *
 * Without this, a leader that stalled past its own lease TTL could delete a
 * lock that has since been reclaimed by a different replica, letting two
 * replicas load the database concurrently.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface RedisSingleFlightOptions {
  /** Lease TTL. Must exceed a normal database query + cache fill. */
  leaseTtlMs: number;
  /** Upper bound on how long a non-leader waits before failing open. */
  waitTimeoutMs: number;
  pollIntervalMs: number;
  pollJitterMs: number;
}

/**
 * Cross-instance single-flight coordination on top of Redis.
 *
 * Only one API replica (the "leader") queries the database for a given cache
 * key at a time; other replicas ("waiters") block on a bounded pub/sub
 * notification, then re-read Redis.
 *
 * This layers on top of — not instead of — local promise memoization: local
 * memoization collapses concurrent requests within one process, this
 * collapses concurrent *leader elections* across processes.
 */
export class RedisSingleFlight implements SingleFlightCoordinator {
  public constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly options: RedisSingleFlightOptions,
  ) {}

  public async acquire(cacheKey: string): Promise<SingleFlightLease> {
    const token = randomUUID();
    const result = await this.redis.set(
      bannerLockKey(cacheKey),
      token,
      'PX',
      this.options.leaseTtlMs,
      'NX',
    );
    return result === 'OK' ? { acquired: true, token } : { acquired: false };
  }

  public async release(cacheKey: string, token: string): Promise<void> {
    const released = await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, bannerLockKey(cacheKey), token);

    if (released !== 1) {
      this.logger.warn(
        { cacheKey },
        'Lease token mismatch on release; lease was likely reclaimed after expiry',
      );
    }

    // Always notify waiters, even on a token mismatch: fresh data is in Redis
    // either way, and waiters should stop waiting.
    await this.redis.publish(bannerReadyChannel(cacheKey), 'ready');
  }

  /**
   * Wait for the leader to finish. Uses the ready notification, with bounded
   * jittered polling as a fallback in case the notification is delayed or
   * dropped. Returns once notified or once waitTimeoutMs elapses — the caller
   * re-reads Redis (or fails open to the database) either way.
   */
  public async waitForLeader(cacheKey: string): Promise<void> {
    const deadline = Date.now() + this.options.waitTimeoutMs;

    const notified = await Promise.race([
      this.waitForNotification(bannerReadyChannel(cacheKey), this.options.waitTimeoutMs),
      this.pollUntilUnlocked(cacheKey, deadline),
    ]);

    if (!notified) {
      this.logger.warn({ cacheKey }, 'Lease wait timed out; falling through to re-read/fallback');
    }
  }

  public async forceReleaseForTesting(cacheKey: string): Promise<void> {
    await this.redis.del(bannerLockKey(cacheKey));
    await this.redis.publish(bannerReadyChannel(cacheKey), 'ready');
  }

  /**
   * Subscribe on a dedicated connection (a subscribed ioredis client cannot
   * run normal commands) and resolve on the first message or on timeout.
   */
  private async waitForNotification(channel: string, timeoutMs: number): Promise<boolean> {
    const subscriber = this.redis.duplicate();
    try {
      await subscriber.subscribe(channel);
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        subscriber.on('message', (receivedChannel: string) => {
          if (receivedChannel === channel) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });
    } finally {
      subscriber.disconnect();
    }
  }

  /** Bounded jittered polling: has the lock key disappeared yet? */
  private async pollUntilUnlocked(cacheKey: string, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      const jitter = Math.floor(Math.random() * this.options.pollJitterMs);
      await sleep(this.options.pollIntervalMs + jitter);

      const stillLocked = await this.redis.get(bannerLockKey(cacheKey));
      if (!stillLocked) return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
