export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Simple failure-counting circuit breaker guarding Redis calls.
 *
 * - closed: calls proceed normally.
 * - open: calls are skipped (fail fast) until resetTimeoutMs elapses.
 * - half-open: after the reset timeout, the next call is allowed through as
 *   a probe; success closes the circuit, failure re-opens it.
 *
 * This exists so repeated Redis failures (e.g. a dead connection under load)
 * don't force every request to pay a connection-timeout penalty before
 * falling back to the database — after `failureThreshold` failures we stop
 * asking Redis entirely for a cool-down window.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private state: CircuitState = 'closed';
  /** Exactly one call may probe the dependency while half-open. */
  private halfOpenProbeInFlight = false;

  public constructor(
    private readonly failureThreshold = 3,
    private readonly resetTimeoutMs = 10_000,
  ) {}

  public isOpen(now = Date.now()): boolean {
    if (this.state === 'closed') return false;

    if (
      this.state === 'open' &&
      this.openedAt !== undefined &&
      now - this.openedAt >= this.resetTimeoutMs
    ) {
      this.state = 'half-open';
      this.halfOpenProbeInFlight = true;
      return false; // This caller owns the recovery probe.
    }

    if (this.state === 'half-open') {
      // A half-open breaker permits one recovery probe only. Letting every
      // concurrent request through here would turn recovery into another
      // Redis connection storm at exactly the moment the dependency is weak.
      if (this.halfOpenProbeInFlight) return true;
      this.halfOpenProbeInFlight = true;
      return false;
    }

    return true; // Still open and inside its cool-down period.
  }

  public getState(): CircuitState {
    return this.state;
  }

  public recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.state = 'closed';
    this.halfOpenProbeInFlight = false;
  }

  /** Test-only deterministic reset; production recovery uses recordSuccess(). */
  public resetForTesting(): void {
    this.recordSuccess();
  }

  public recordFailure(now = Date.now()): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.halfOpenProbeInFlight = false;
    }
  }
}
