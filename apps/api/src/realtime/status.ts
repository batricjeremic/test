/**
 * Degraded mode, made visible.
 *
 * Spec, "Caching, rate limits and realtime": one service hook
 * subscription per project on `workitem.updated`. "If service hooks are
 * not available or a project is added without one, the hub falls back to
 * polling every 30 seconds and shows a quiet 'live updates off'
 * indicator, so degraded mode is visible rather than silent."
 *
 * So the snapshot always carries a `RealtimeStatus`, and it is computed
 * from facts the service actually knows: which projects have a
 * subscription registered, and whether the cache is serving. Silence is
 * the failure the spec forbids.
 */
import { DEFAULT_POLL_INTERVAL_SECONDS } from '@eg/shared';
import type { RealtimeStatus } from '@eg/shared';
import type { Logger } from '../ports.js';

/**
 * Which projects have a `workitem.updated` subscription. Filled in when
 * a subscription is created or discovered at startup, and consulted per
 * board: a board is live only when every project it reads from is
 * covered, because one uncovered project means silently stale cards.
 */
export class ServiceHookRegistry {
  readonly #subscribed = new Map<string, string>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'service-hooks' });
  }

  /** Records the subscription id covering one project. */
  markSubscribed(projectId: string, subscriptionId: string): void {
    this.#subscribed.set(projectId, subscriptionId);
    this.#logger.info('service hook subscription registered', {
      projectId,
      subscriptionId,
    });
  }

  /** Drops a project, e.g. after a delivery failure or a 404 on it. */
  markUnsubscribed(projectId: string): void {
    if (!this.#subscribed.delete(projectId)) return;
    this.#logger.warn('service hook subscription lost', { projectId });
  }

  has(projectId: string): boolean {
    return this.#subscribed.has(projectId);
  }

  /** The projects with no subscription, in the order they were given. */
  missing(projectIds: readonly string[]): readonly string[] {
    return projectIds.filter((projectId) => !this.#subscribed.has(projectId));
  }

  get subscribedProjectIds(): readonly string[] {
    return [...this.#subscribed.keys()];
  }
}

export interface RealtimeStatusInput {
  readonly channel: string;
  /** Projects the board reads from; each one needs its own hook. */
  readonly projectIds: readonly string[];
  readonly hooks: Pick<ServiceHookRegistry, 'missing'>;
  /** `CacheStore.healthy`: without Redis a hook cannot fan out. */
  readonly cacheHealthy: boolean;
  /** The client asked for polling itself, e.g. its socket kept failing. */
  readonly clientFallback?: boolean;
  readonly pollIntervalSeconds?: number;
}

/**
 * The board's realtime health. Reasons are ordered by what the operator
 * should fix first: a missing subscription is a configuration gap, an
 * unhealthy cache is an incident, a client fallback is neither.
 */
export function realtimeStatusFor(input: RealtimeStatusInput): RealtimeStatus {
  const pollIntervalSeconds =
    input.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const missing = input.hooks.missing(input.projectIds);
  const reason =
    missing.length > 0
      ? 'service-hooks-missing'
      : !input.cacheHealthy
        ? 'cache-unavailable'
        : input.clientFallback === true
          ? 'client-fallback'
          : null;
  return {
    mode: reason === null ? 'live' : 'polling',
    channel: input.channel,
    pollIntervalSeconds,
    reason,
  };
}
