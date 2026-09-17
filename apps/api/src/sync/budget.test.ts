import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../ado/rate-limit.js';
import type { AdoRateLimitState } from '../ado/types.js';
import {
  cooldownMsFor,
  createSyncBucket,
  SyncBudget,
  SyncBudgetExhausted,
} from './budget.js';
import { FakeAdoClient, TestClock } from './test-support.js';

const state = (
  overrides: Partial<AdoRateLimitState> = {},
): AdoRateLimitState => ({
  remaining: 500,
  limit: 1000,
  resetEpochSeconds: null,
  retryAfterSeconds: null,
  observedAt: '2026-09-17T06:00:00.000Z',
  ...overrides,
});

const now = new Date('2026-09-17T06:00:00.000Z');

describe('cooldownMsFor', () => {
  it('is clear before the first call', () => {
    expect(cooldownMsFor(null, now, 25)).toBe(0);
  });

  it('is clear while the budget is comfortable', () => {
    expect(cooldownMsFor(state(), now, 25)).toBe(0);
  });

  it('honours what is left of a Retry-After', () => {
    const observed = state({
      retryAfterSeconds: 30,
      observedAt: '2026-09-17T05:59:50.000Z',
    });
    expect(cooldownMsFor(observed, now, 25)).toBe(20_000);
  });

  it('waits for the window when the interactive reserve is reached', () => {
    const observed = state({
      remaining: 10,
      resetEpochSeconds: Math.floor(now.getTime() / 1000) + 45,
    });
    expect(cooldownMsFor(observed, now, 25)).toBe(45_000);
    // Above the reserve the worker keeps going.
    expect(cooldownMsFor({ ...observed, remaining: 400 }, now, 25)).toBe(0);
  });

  it('never returns a negative cooldown from a stale header', () => {
    const observed = state({
      retryAfterSeconds: 5,
      observedAt: '2026-09-17T05:00:00.000Z',
    });
    expect(cooldownMsFor(observed, now, 25)).toBe(0);
  });
});

describe('SyncBudget', () => {
  const makeBudget = (
    options: {
      capacity?: number;
      refillPerMinute?: number;
      maxWaitMs?: number;
      slept?: number[];
    } = {},
  ): { budget: SyncBudget; ado: FakeAdoClient; clock: TestClock } => {
    const clock = new TestClock();
    const ado = new FakeAdoClient();
    const bucket = new TokenBucket({
      capacity: options.capacity ?? 4,
      refillPerMinute: options.refillPerMinute ?? 60,
      clock,
      sleep: async (ms) => {
        options.slept?.push(ms);
        clock.advance(ms);
      },
    });
    const budget = new SyncBudget({
      bucket,
      ado,
      clock,
      sleep: async (ms) => {
        options.slept?.push(ms);
        clock.advance(ms);
      },
      ...(options.maxWaitMs === undefined
        ? {}
        : { maxWaitMs: options.maxWaitMs }),
    });
    return { budget, ado, clock };
  };

  it('grants and spends one token per call', async () => {
    const { budget } = makeBudget({ capacity: 2 });

    await expect(budget.acquire()).resolves.toEqual({ granted: true });
    await expect(budget.acquire()).resolves.toEqual({ granted: true });
    expect(budget.decide()).toMatchObject({
      granted: false,
      reason: 'no-tokens',
    });
  });

  it('waits for a refill rather than refusing outright', async () => {
    const slept: number[] = [];
    const { budget } = makeBudget({ capacity: 1, refillPerMinute: 60, slept });

    await budget.acquire();
    await expect(budget.acquire()).resolves.toEqual({ granted: true });
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it('refuses when the wait would be longer than a cycle can afford', async () => {
    const { budget } = makeBudget({
      capacity: 1,
      refillPerMinute: 1,
      maxWaitMs: 1_000,
    });

    await budget.acquire();
    await expect(budget.acquire()).resolves.toMatchObject({
      granted: false,
      reason: 'no-tokens',
    });
  });

  it('yields to the interactive path when Azure DevOps is throttling', async () => {
    const { budget, ado } = makeBudget({ maxWaitMs: 1_000 });
    ado.rateLimit = state({
      retryAfterSeconds: 120,
      observedAt: '2026-09-17T06:00:00.000Z',
    });

    expect(budget.decide()).toMatchObject({
      granted: false,
      reason: 'throttled',
    });
    await expect(budget.acquire()).resolves.toMatchObject({
      granted: false,
      reason: 'throttled',
      waitMs: 120_000,
    });
  });

  it('refuses immediately on an aborted signal', async () => {
    const { budget } = makeBudget();
    await expect(budget.acquire(AbortSignal.abort())).resolves.toMatchObject({
      granted: false,
      reason: 'aborted',
    });
  });

  it('require() throws so a refusal ends the whole cycle', async () => {
    const { budget, ado } = makeBudget({ maxWaitMs: 1_000 });
    ado.rateLimit = state({ retryAfterSeconds: 120 });

    await expect(budget.require()).rejects.toBeInstanceOf(SyncBudgetExhausted);
    await expect(budget.require()).rejects.toMatchObject({
      reason: 'throttled',
    });
  });
});

describe('createSyncBucket', () => {
  it('bursts at a quarter of the configured minute budget', () => {
    const bucket = createSyncBucket(200, new TestClock());
    expect(bucket.capacity).toBe(50);
    expect(bucket.refillPerMinute).toBe(200);
  });

  it('always leaves room for at least one call', () => {
    expect(createSyncBucket(1, new TestClock()).capacity).toBe(1);
  });
});
