/**
 * The sync worker's share of the Azure DevOps throttling budget.
 *
 * Spec, "Caching, rate limits and realtime": Azure DevOps throttles per
 * identity over a sliding window; because reads are concentrated on one
 * service identity, "that budget is a shared resource, so the worker
 * runs at low concurrency with a token bucket in front of it" and "must
 * back off before the interactive path is affected".
 *
 * Two gates, in that order:
 *
 * 1. **What Azure DevOps last told us.** `Retry-After`, and a spent or
 *    nearly spent `X-RateLimit-Remaining`, hold the worker off until the
 *    window resets. The reserve is what keeps a user's board load fast
 *    while a sweep is running.
 * 2. **Our own token bucket**, shared with the interactive path so the
 *    two cannot together exceed the configured rate.
 *
 * Every wait is bounded: past `maxWaitMs` the worker gives the cycle up
 * rather than parking a promise for the rest of the window.
 */
import { TokenBucket } from '../ado/rate-limit.js';
import { defaultSleep, type Sleep } from '../ado/time.js';
import type { AdoRateLimitState } from '../ado/types.js';
import type { AdoAuth, AdoClient, Clock } from '../ports.js';

/** Calls left on the identity that the worker will not spend. */
export const DEFAULT_INTERACTIVE_RESERVE = 25;

/** Longest the worker will wait for budget before skipping the cycle. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

/** The worker always reads as the service identity. */
export const SERVICE_AUTH: AdoAuth = { kind: 'service' };

/**
 * How long the worker must hold off, given the last headers seen for
 * that identity. Pure, so the backoff table is unit-testable.
 */
export function cooldownMsFor(
  state: AdoRateLimitState | null,
  now: Date,
  reserve: number,
): number {
  if (state === null) return 0;
  const nowMs = now.getTime();
  const observedMs = Date.parse(state.observedAt);
  let cooldown = 0;
  if (state.retryAfterSeconds !== null && Number.isFinite(observedMs)) {
    cooldown = Math.max(
      cooldown,
      observedMs + state.retryAfterSeconds * 1_000 - nowMs,
    );
  }
  const nearlySpent = state.remaining !== null && state.remaining <= reserve;
  if (nearlySpent && state.resetEpochSeconds !== null) {
    cooldown = Math.max(cooldown, state.resetEpochSeconds * 1_000 - nowMs);
  }
  return cooldown > 0 ? Math.ceil(cooldown) : 0;
}

export type BudgetRefusal = 'throttled' | 'no-tokens' | 'aborted';

export type BudgetDecision =
  | { readonly granted: true }
  | {
      readonly granted: false;
      readonly reason: BudgetRefusal;
      readonly waitMs: number;
    };

/** Thrown through a prefetch so the whole cycle ends, not just one call. */
export class SyncBudgetExhausted extends Error {
  readonly reason: BudgetRefusal;
  readonly waitMs: number;

  constructor(reason: BudgetRefusal, waitMs: number) {
    super(`sync budget exhausted: ${reason}`);
    this.name = 'SyncBudgetExhausted';
    this.reason = reason;
    this.waitMs = waitMs;
  }
}

export interface SyncBudgetOptions {
  readonly bucket: TokenBucket;
  readonly ado: Pick<AdoClient, 'rateLimitState'>;
  readonly clock: Clock;
  readonly sleep?: Sleep;
  readonly interactiveReserve?: number;
  readonly maxWaitMs?: number;
}

export class SyncBudget {
  readonly #bucket: TokenBucket;
  readonly #ado: Pick<AdoClient, 'rateLimitState'>;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #reserve: number;
  readonly #maxWaitMs: number;

  constructor(options: SyncBudgetOptions) {
    this.#bucket = options.bucket;
    this.#ado = options.ado;
    this.#clock = options.clock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#reserve = options.interactiveReserve ?? DEFAULT_INTERACTIVE_RESERVE;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /** What the budget says right now, without waiting for anything. */
  decide(): BudgetDecision {
    const cooldown = cooldownMsFor(
      this.#ado.rateLimitState(SERVICE_AUTH),
      this.#clock.now(),
      this.#reserve,
    );
    if (cooldown > 0) {
      return { granted: false, reason: 'throttled', waitMs: cooldown };
    }
    const tokenWait = this.#bucket.waitMsFor(1);
    if (tokenWait > 0) {
      return { granted: false, reason: 'no-tokens', waitMs: tokenWait };
    }
    return { granted: true };
  }

  /**
   * Waits for one call's worth of budget, up to `maxWaitMs`. Refuses
   * rather than waiting longer, so a throttled organisation costs the
   * worker one cycle and never a stuck promise.
   */
  async acquire(signal?: AbortSignal): Promise<BudgetDecision> {
    if (signal?.aborted === true) {
      return { granted: false, reason: 'aborted', waitMs: 0 };
    }
    const cooldown = cooldownMsFor(
      this.#ado.rateLimitState(SERVICE_AUTH),
      this.#clock.now(),
      this.#reserve,
    );
    if (cooldown > this.#maxWaitMs) {
      return { granted: false, reason: 'throttled', waitMs: cooldown };
    }
    if (cooldown > 0) await this.#sleep(cooldown, signal);

    const tokenWait = this.#bucket.waitMsFor(1);
    if (tokenWait > this.#maxWaitMs) {
      return { granted: false, reason: 'no-tokens', waitMs: tokenWait };
    }
    await this.#bucket.take(1, signal);
    return { granted: true };
  }

  /** `acquire`, but a refusal ends the cycle. */
  async require(signal?: AbortSignal): Promise<void> {
    const decision = await this.acquire(signal);
    if (decision.granted) return;
    throw new SyncBudgetExhausted(decision.reason, decision.waitMs);
  }
}

/** Convenience for the composition root: the worker's shared bucket. */
export function createSyncBucket(
  rateBudgetPerMinute: number,
  clock: Clock,
  sleep?: Sleep,
): TokenBucket {
  return new TokenBucket({
    capacity: Math.max(1, Math.ceil(rateBudgetPerMinute / 4)),
    refillPerMinute: rateBudgetPerMinute,
    clock,
    ...(sleep === undefined ? {} : { sleep }),
  });
}
