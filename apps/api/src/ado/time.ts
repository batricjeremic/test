/**
 * The two pieces of wall-clock behaviour the Azure DevOps client needs,
 * behind seams so the retry and token-bucket tests never sleep for real.
 *
 * Serves the ExpertGroup rule that every outbound call has an explicit
 * timeout: the delays here are always bounded and always cancellable.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '../ports.js';

/** Cancellable sleep. Rejects when `signal` aborts, never hangs. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Real timers. Tests pass a fake that resolves immediately. */
export const defaultSleep: Sleep = async (ms, signal) => {
  if (ms <= 0) return;
  await delay(ms, undefined, signal === undefined ? {} : { signal });
};

/** The process clock, as the `Clock` port. */
export const adoSystemClock: Clock = {
  now: () => new Date(),
};

/**
 * Combines the per-call timeout with any caller-supplied signal, so a
 * request is abandoned when either fires. Node 22 has `AbortSignal.any`.
 */
export function withTimeoutSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}
