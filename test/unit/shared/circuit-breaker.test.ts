import { CircuitBreaker } from '../../../src/shared/resilience/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const breaker = new CircuitBreaker(3, 1000);
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe('closed');
  });

  it('opens once the failure threshold is reached', () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.getState()).toBe('open');
  });

  it('resets the failure count on success', () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it('resets an open circuit deterministically for test setup', () => {
    const breaker = new CircuitBreaker(1, 1000);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    breaker.resetForTesting();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe('closed');
  });

  it('moves to half-open after the reset timeout, permits one probe, then closes on success', () => {
    const breaker = new CircuitBreaker(1, 100);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000)).toBe(true);
    expect(breaker.isOpen(1050)).toBe(true); // still inside the cool-down

    expect(breaker.isOpen(1150)).toBe(false); // half-open: first probe allowed
    expect(breaker.isOpen(1150)).toBe(true); // concurrent callers still fail open
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens immediately if the half-open probe fails', () => {
    const breaker = new CircuitBreaker(1, 100);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1150)).toBe(false); // half-open

    breaker.recordFailure(1150);
    expect(breaker.isOpen(1150)).toBe(true);
  });
});
