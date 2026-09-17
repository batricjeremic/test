/**
 * Retry policy for Azure DevOps calls.
 *
 * Serves the last row of the spec's write-path failure table: "Azure
 * DevOps 5xx or throttle — retry twice with backoff, then roll back and
 * say the service is busy". Twice means three attempts in total, and
 * nothing else is retried: a 4xx that is not a 429 is the caller's
 * fault and retrying it only burns the shared rate-limit budget.
 */

export interface RetryPolicy {
  /** Total attempts, including the first. Three is "retry twice". */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Ceiling for a computed backoff. */
  readonly maxDelayMs: number;
  /** Ceiling for an honoured `Retry-After`, so a huge header cannot
   *  wedge a request for minutes. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
};

/** 429 and 5xx only. Every other status is final. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Backoff for the attempt that just failed, `attempt` being 1-based.
 *
 * A `Retry-After` is honoured verbatim (clamped), because the service
 * has told us when it will be ready and guessing shorter is rude.
 * Otherwise the delay is exponential with half jitter: half the window
 * is fixed so progress is guaranteed, half is random so a fleet of
 * callers does not resynchronise on the same retry instant.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterSeconds: number | null,
  random: () => number,
): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return Math.min(
      Math.ceil(retryAfterSeconds * 1_000),
      policy.maxRetryAfterMs,
    );
  }
  const exponent = Math.max(0, attempt - 1);
  const window = Math.min(
    policy.baseDelayMs * 2 ** exponent,
    policy.maxDelayMs,
  );
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(window * (0.5 + 0.5 * jitter));
}
