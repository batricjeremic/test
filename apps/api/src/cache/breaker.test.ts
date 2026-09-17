import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from './breaker.js';
import { TestClock } from './test-support.js';

describe('createCircuitBreaker', () => {
  it('stays closed while commands succeed', () => {
    const breaker = createCircuitBreaker({ clock: new TestClock() });
    breaker.recordSuccess();
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe('closed');
  });

  it('opens after the threshold and short-circuits', () => {
    const clock = new TestClock();
    const breaker = createCircuitBreaker({
      clock,
      failureThreshold: 2,
      openDurationMs: 1_000,
    });
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
  });

  it('allows one probe once the open window has passed', () => {
    const clock = new TestClock();
    const breaker = createCircuitBreaker({
      clock,
      failureThreshold: 1,
      openDurationMs: 1_000,
    });
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);
    clock.advance(1_000);
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe('half-open');
  });

  it('reopens immediately when the probe fails', () => {
    const clock = new TestClock();
    const breaker = createCircuitBreaker({
      clock,
      failureThreshold: 1,
      openDurationMs: 1_000,
    });
    breaker.recordFailure();
    clock.advance(1_000);
    breaker.canAttempt();
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);
  });

  it('closes again when the probe succeeds', () => {
    const clock = new TestClock();
    const breaker = createCircuitBreaker({
      clock,
      failureThreshold: 1,
      openDurationMs: 1_000,
    });
    breaker.recordFailure();
    clock.advance(1_000);
    breaker.canAttempt();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });
});
