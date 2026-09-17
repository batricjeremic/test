/**
 * A very small circuit breaker, so a dead Redis costs one command
 * timeout rather than adding it to every request.
 *
 * Serves "Caching, rate limits and realtime": the board must still
 * render when the cache is gone, just slower. Without this, "slower"
 * would mean the command timeout on every read and write of every
 * request, which is how a degraded cache turns into a degraded board.
 */
import type { Clock } from '../ports.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default 3. */
  readonly failureThreshold?: number;
  /** How long it stays open before one probe is allowed. Default 5 s. */
  readonly openDurationMs?: number;
  readonly clock?: Clock;
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  /** True when a command may be attempted now. */
  canAttempt(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_OPEN_DURATION_MS = 5_000;

const systemClock: Clock = { now: () => new Date() };

class ConsecutiveFailureBreaker implements CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private openedUntilMs = 0;
  private readonly threshold: number;
  private readonly openDurationMs: number;
  private readonly clock: Clock;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openDurationMs = options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.clock = options.clock ?? systemClock;
  }

  get state(): CircuitState {
    return this.current;
  }

  canAttempt(): boolean {
    if (this.current !== 'open') return true;
    if (this.clock.now().getTime() < this.openedUntilMs) return false;
    this.current = 'half-open';
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.current = 'closed';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.threshold) {
      this.current = 'open';
      this.openedUntilMs = this.clock.now().getTime() + this.openDurationMs;
    }
  }
}

export function createCircuitBreaker(
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  return new ConsecutiveFailureBreaker(options);
}
