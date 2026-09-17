import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  isRetryableStatus,
} from './retry.js';

describe('isRetryableStatus', () => {
  it('retries throttling and service-side failures only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('never retries a 4xx that is not a 429', () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially between attempts', () => {
    const half = backoffDelayMs(1, DEFAULT_RETRY_POLICY, null, () => 0);
    const second = backoffDelayMs(2, DEFAULT_RETRY_POLICY, null, () => 0);
    const third = backoffDelayMs(3, DEFAULT_RETRY_POLICY, null, () => 0);
    expect(half).toBe(125);
    expect(second).toBe(250);
    expect(third).toBe(500);
  });

  it('keeps the jittered delay inside half the window and the window', () => {
    for (const attempt of [1, 2, 3, 4]) {
      const window = Math.min(
        DEFAULT_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
        DEFAULT_RETRY_POLICY.maxDelayMs,
      );
      for (const jitter of [0, 0.25, 0.5, 0.99, 1]) {
        const delay = backoffDelayMs(
          attempt,
          DEFAULT_RETRY_POLICY,
          null,
          () => jitter,
        );
        expect(delay).toBeGreaterThanOrEqual(window / 2);
        expect(delay).toBeLessThanOrEqual(window);
      }
    }
  });

  it('caps the exponential growth at maxDelayMs', () => {
    const delay = backoffDelayMs(20, DEFAULT_RETRY_POLICY, null, () => 1);
    expect(delay).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('honours Retry-After verbatim when the service sends one', () => {
    const delay = backoffDelayMs(1, DEFAULT_RETRY_POLICY, 7, () => 0);
    expect(delay).toBe(7_000);
  });

  it('clamps an absurd Retry-After rather than wedging the request', () => {
    const delay = backoffDelayMs(1, DEFAULT_RETRY_POLICY, 3_600, () => 0);
    expect(delay).toBe(DEFAULT_RETRY_POLICY.maxRetryAfterMs);
  });

  it('falls back to the exponential delay for a zero Retry-After', () => {
    const delay = backoffDelayMs(1, DEFAULT_RETRY_POLICY, 0, () => 0);
    expect(delay).toBe(125);
  });

  it('allows retrying twice, which is three attempts in total', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });
});
