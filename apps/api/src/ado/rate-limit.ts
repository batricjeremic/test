/**
 * Rate limiting for the Azure DevOps client.
 *
 * Serves "Caching, rate limits and realtime": Azure DevOps throttles per
 * identity over a sliding window and signals it with
 * `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Retry-After`. The
 * client records those headers on every response, not only on a 429, and
 * exposes the budget here so the sync worker can back off before the
 * interactive path is affected.
 *
 * Because reads concentrate on one service identity, that budget is a
 * shared resource: the `TokenBucket` below is deliberately shareable, so
 * a worker and the request path can be handed the same instance.
 */
import type { AdoAuth, Clock } from '../ports.js';
import { adoSystemClock, defaultSleep, type Sleep } from './time.js';
import type { AdoRateLimitState } from './types.js';

const MS_PER_MINUTE = 60_000;

/**
 * The throttling budget is per identity, so state is keyed the same way.
 * A user key carries the descriptor, which is an id and not personal
 * data, so it is safe to log.
 */
export function identityKey(auth: AdoAuth): string {
  return auth.kind === 'service' ? 'service' : `user:${auth.descriptor}`;
}

export interface TokenBucketOptions {
  /** Burst size. Also the largest single reservation allowed. */
  readonly capacity: number;
  /** Steady-state refill, expressed the way the config expresses it. */
  readonly refillPerMinute: number;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
}

/**
 * A shared token bucket. `take` waits rather than rejecting, because the
 * caller has already decided the call must happen; the worker chooses
 * not to call at all by consulting `available` first.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerMinute: number;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  #tokens: number;
  #lastRefillMs: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) {
      throw new RangeError('TokenBucket capacity must be positive');
    }
    if (options.refillPerMinute <= 0) {
      throw new RangeError('TokenBucket refillPerMinute must be positive');
    }
    this.capacity = options.capacity;
    this.refillPerMinute = options.refillPerMinute;
    this.#clock = options.clock ?? adoSystemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#tokens = options.capacity;
    this.#lastRefillMs = this.#clock.now().getTime();
  }

  /** Whole tokens available right now, after accounting for refill. */
  get available(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  /** Takes `count` tokens if they are there. Never waits. */
  tryTake(count = 1): boolean {
    this.#assertCount(count);
    this.#refill();
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  /** Waits for `count` tokens, then takes them. */
  async take(count = 1, signal?: AbortSignal): Promise<void> {
    this.#assertCount(count);
    for (;;) {
      signal?.throwIfAborted();
      this.#refill();
      if (this.#tokens >= count) {
        this.#tokens -= count;
        return;
      }
      await this.#sleep(this.waitMsFor(count), signal);
    }
  }

  /** How long until `count` tokens exist. Zero when they already do. */
  waitMsFor(count = 1): number {
    this.#assertCount(count);
    this.#refill();
    const deficit = count - this.#tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / this.refillPerMinute) * MS_PER_MINUTE);
  }

  #assertCount(count: number): void {
    if (!Number.isFinite(count) || count <= 0) {
      throw new RangeError('TokenBucket count must be a positive number');
    }
    if (count > this.capacity) {
      throw new RangeError(
        `TokenBucket count ${count} exceeds capacity ${this.capacity}`,
      );
    }
  }

  #refill(): void {
    const nowMs = this.#clock.now().getTime();
    const elapsedMs = nowMs - this.#lastRefillMs;
    if (elapsedMs <= 0) return;
    this.#lastRefillMs = nowMs;
    const gained = (elapsedMs / MS_PER_MINUTE) * this.refillPerMinute;
    this.#tokens = Math.min(this.capacity, this.#tokens + gained);
  }
}

/**
 * Remembers the last throttling headers seen per identity. This is what
 * `AdoClient.rateLimitState` returns and what the sync worker reads to
 * decide whether to run this cycle at all.
 */
export class RateLimitTracker {
  readonly #states = new Map<string, AdoRateLimitState>();

  record(auth: AdoAuth, state: AdoRateLimitState): void {
    this.#states.set(identityKey(auth), state);
  }

  state(auth: AdoAuth): AdoRateLimitState | null {
    return this.#states.get(identityKey(auth)) ?? null;
  }

  /**
   * Milliseconds the caller should hold off for that identity: what is
   * left of a `Retry-After`, or of the window when the budget is spent.
   * Zero means the budget is clear.
   */
  cooldownMs(auth: AdoAuth, now: Date): number {
    const state = this.state(auth);
    if (state === null) return 0;
    const observedMs = Date.parse(state.observedAt);
    const nowMs = now.getTime();
    let cooldown = 0;
    if (state.retryAfterSeconds !== null && Number.isFinite(observedMs)) {
      const until = observedMs + state.retryAfterSeconds * 1_000;
      cooldown = Math.max(cooldown, until - nowMs);
    }
    if (state.remaining !== null && state.remaining <= 0) {
      if (state.resetEpochSeconds !== null) {
        const until = state.resetEpochSeconds * 1_000;
        cooldown = Math.max(cooldown, until - nowMs);
      }
    }
    return cooldown > 0 ? Math.ceil(cooldown) : 0;
  }
}
