import { describe, expect, it } from 'vitest';
import type { AdoAuth, Clock } from '../ports.js';
import { RateLimitTracker, TokenBucket, identityKey } from './rate-limit.js';
import { parseAdoRateLimitHeaders } from './types.js';

const SERVICE: AdoAuth = { kind: 'service' };
const USER: AdoAuth = {
  kind: 'user',
  accessToken: 'never-logged',
  descriptor: 'aad.abc123',
};

class FakeClock implements Clock {
  #ms: number;
  constructor(startIso: string) {
    this.#ms = Date.parse(startIso);
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

describe('identityKey', () => {
  it('keys the budget per identity, by descriptor and not by name', () => {
    expect(identityKey(SERVICE)).toBe('service');
    expect(identityKey(USER)).toBe('user:aad.abc123');
  });
});

describe('TokenBucket', () => {
  it('starts full and spends down', () => {
    const clock = new FakeClock('2026-09-17T09:00:00.000Z');
    const bucket = new TokenBucket({
      capacity: 3,
      refillPerMinute: 60,
      clock,
    });
    expect(bucket.available).toBe(3);
    expect(bucket.tryTake(2)).toBe(true);
    expect(bucket.available).toBe(1);
    expect(bucket.tryTake(2)).toBe(false);
  });

  it('refills over time and never exceeds capacity', () => {
    const clock = new FakeClock('2026-09-17T09:00:00.000Z');
    const bucket = new TokenBucket({
      capacity: 4,
      refillPerMinute: 60,
      clock,
    });
    expect(bucket.tryTake(4)).toBe(true);
    clock.advance(2_000);
    expect(bucket.available).toBe(2);
    clock.advance(600_000);
    expect(bucket.available).toBe(4);
  });

  it('reports how long a caller would wait', () => {
    const clock = new FakeClock('2026-09-17T09:00:00.000Z');
    const bucket = new TokenBucket({
      capacity: 2,
      refillPerMinute: 60,
      clock,
    });
    expect(bucket.waitMsFor(2)).toBe(0);
    bucket.tryTake(2);
    expect(bucket.waitMsFor(1)).toBe(1_000);
  });

  it('waits for a token rather than rejecting', async () => {
    const clock = new FakeClock('2026-09-17T09:00:00.000Z');
    const slept: number[] = [];
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerMinute: 60,
      clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms);
      },
    });
    await bucket.take(1);
    await bucket.take(1);
    expect(slept).toEqual([1_000]);
  });

  it('refuses a reservation larger than the bucket', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 60 });
    expect(() => bucket.tryTake(3)).toThrow(RangeError);
  });
});

describe('RateLimitTracker', () => {
  const observedAt = new Date('2026-09-17T09:00:00.000Z');

  it('keeps one budget per identity', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      SERVICE,
      parseAdoRateLimitHeaders({ 'x-ratelimit-remaining': '17' }, observedAt),
    );
    expect(tracker.state(SERVICE)?.remaining).toBe(17);
    expect(tracker.state(USER)).toBeNull();
  });

  it('turns Retry-After into a cooldown that decays with time', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      SERVICE,
      parseAdoRateLimitHeaders({ 'retry-after': '30' }, observedAt),
    );
    expect(
      tracker.cooldownMs(SERVICE, new Date('2026-09-17T09:00:00.000Z')),
    ).toBe(30_000);
    expect(
      tracker.cooldownMs(SERVICE, new Date('2026-09-17T09:00:20.000Z')),
    ).toBe(10_000);
    expect(
      tracker.cooldownMs(SERVICE, new Date('2026-09-17T09:01:00.000Z')),
    ).toBe(0);
  });

  it('holds off until the window resets when the budget is spent', () => {
    const tracker = new RateLimitTracker();
    const reset = Math.floor(
      new Date('2026-09-17T09:00:45.000Z').getTime() / 1_000,
    );
    tracker.record(
      SERVICE,
      parseAdoRateLimitHeaders(
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        observedAt,
      ),
    );
    expect(tracker.cooldownMs(SERVICE, observedAt)).toBe(45_000);
  });

  it('is clear when the budget is healthy', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      SERVICE,
      parseAdoRateLimitHeaders({ 'x-ratelimit-remaining': '199' }, observedAt),
    );
    expect(tracker.cooldownMs(SERVICE, observedAt)).toBe(0);
  });
});
