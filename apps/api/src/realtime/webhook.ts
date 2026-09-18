/**
 * The `workitem.updated` service hook endpoint.
 *
 * Spec, "Realtime": "On receipt the BFF invalidates the affected board
 * snapshots and pushes a delta to any open board." Four rules shape the
 * implementation:
 *
 * 1. **Never trust the body alone.** The delivery is authenticated with
 *    the credentials the subscription was created with, in `verify.js`,
 *    before anything is read out of it.
 * 2. **Validate what crosses the boundary.** The document is parsed with
 *    the Zod schema for the REST 7.1 event, so a shape change is a 400
 *    and not a crash halfway through an invalidation.
 * 3. **Answer fast, then work.** Azure DevOps retries and eventually
 *    disables a slow consumer, so the route acknowledges with 202 and
 *    the fan-out runs on a tracked queue.
 * 4. **Never swallow an error.** The queue logs every failure with the
 *    delivery's trace id, and `drain()` lets shutdown wait for the work
 *    instead of abandoning it.
 */
import { setImmediate } from 'node:timers';
import type { BoardCard, CardDelta } from '@eg/shared';
import {
  adoWorkItemUpdatedEventSchema,
  ADO_FIELDS,
  type AdoWorkItemUpdatedEvent,
} from '../ado/types.js';
import type { CacheInvalidator } from '../cache/invalidation.js';
import { toAppError, UnauthorizedError, ValidationError } from '../errors.js';
import type { CallOptions, Logger } from '../ports.js';
import type { PublishDeltaInput } from './hub.js';
import type { RealtimeEnvelope } from '@eg/shared';
import type { ServiceHookRegistry } from './status.js';
import { verifyWebhookRequest, type WebhookAuth } from './verify.js';

/**
 * Resolves what a board should now show for one work item. Backed by the
 * read path, injected so this module never reaches for a snapshot
 * builder. `null` means the card is no longer on that board.
 */
export interface WebhookCardLookup {
  lookup(
    boardId: string,
    workItemId: number,
    options: CallOptions,
  ): Promise<BoardCard | null>;
}

/** The slice of the hub the webhook uses. */
export interface DeltaPublisher {
  publishDelta(
    input: PublishDeltaInput,
    options: CallOptions,
  ): Promise<RealtimeEnvelope>;
  subscriberCount(boardId: string): number;
}

export interface WorkItemUpdatedDeps {
  readonly logger: Logger;
  readonly invalidator: CacheInvalidator;
  readonly publisher: DeltaPublisher;
  /**
   * Optional. Without it the snapshot is still invalidated, but no delta
   * can be built, so open boards only catch up on their next poll. That
   * is logged at warn rather than passed over.
   */
  readonly cards?: WebhookCardLookup;
  /**
   * Optional. Given it, a delivery teaches the service that the project's
   * service hook exists, which is what turns the board's realtime status
   * from "polling, hooks missing" into "live".
   */
  readonly hooks?: Pick<ServiceHookRegistry, 'markSubscribed'>;
}

export interface WebhookProcessResult {
  readonly workItemId: number;
  readonly boardIds: readonly string[];
  readonly published: number;
  readonly skipped: number;
}

const updatedFieldNames = (event: AdoWorkItemUpdatedEvent): string[] =>
  Object.keys(event.resource.fields ?? {});

/**
 * Why a card that is no longer on a board left it. The hook tells us
 * which fields changed, which is enough to distinguish a resprint from
 * an out-of-scope reassignment; anything else is reported as
 * out-of-scope rather than guessed at.
 */
export function removalCause(
  event: AdoWorkItemUpdatedEvent,
): 'deleted' | 'out-of-scope' | 'iteration-changed' {
  const changed = updatedFieldNames(event);
  const moved =
    changed.includes(ADO_FIELDS.iterationPath) ||
    changed.includes(ADO_FIELDS.iterationId);
  return moved ? 'iteration-changed' : 'out-of-scope';
}

/**
 * Invalidates the snapshots holding this work item and pushes a delta on
 * each affected board. Exported on its own so the fan-out is tested
 * without a socket or an HTTP server.
 */
export async function processWorkItemUpdated(
  event: AdoWorkItemUpdatedEvent,
  deps: WorkItemUpdatedDeps,
  options: CallOptions,
): Promise<WebhookProcessResult> {
  const log = deps.logger.withTraceId(options.traceId);
  const workItemId = event.resource.workItemId;
  const boardIds = await deps.invalidator.invalidateWorkItem(
    workItemId,
    options,
  );

  let published = 0;
  let skipped = 0;
  for (const boardId of boardIds) {
    if (deps.publisher.subscriberCount(boardId) === 0) {
      skipped += 1;
      continue;
    }
    const delta = await resolveDelta(boardId, event, deps, options);
    if (delta === null) {
      skipped += 1;
      continue;
    }
    await deps.publisher.publishDelta(
      { boardId, delta, origin: 'service-hook', traceId: options.traceId },
      options,
    );
    published += 1;
  }

  log.info('work item hook processed', {
    workItemId,
    rev: event.resource.rev,
    boardCount: boardIds.length,
    published,
    skipped,
  });
  return { workItemId, boardIds, published, skipped };
}

const resolveDelta = async (
  boardId: string,
  event: AdoWorkItemUpdatedEvent,
  deps: WorkItemUpdatedDeps,
  options: CallOptions,
): Promise<CardDelta | null> => {
  if (deps.cards === undefined) {
    deps.logger
      .withTraceId(options.traceId)
      .warn('no card lookup configured, open boards will poll instead', {
        boardId,
        workItemId: event.resource.workItemId,
      });
    return null;
  }
  const card = await deps.cards.lookup(
    boardId,
    event.resource.workItemId,
    options,
  );
  if (card !== null) return { kind: 'card-upserted', card };
  return {
    kind: 'card-removed',
    workItemId: event.resource.workItemId,
    cause: removalCause(event),
  };
};

/* ------------------------------------------------------------------ */
/* Deferred work                                                       */
/* ------------------------------------------------------------------ */

/**
 * Work started after the 202 went out. Every task is tracked, so a
 * failure is logged rather than becoming an unhandled rejection and
 * shutdown can wait for what is in flight.
 */
/** Yields the event loop, so the acknowledgement goes out first. */
const deferred = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

export class WebhookWorkQueue {
  readonly #logger: Logger;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'webhook-queue' });
  }

  get pending(): number {
    return this.#inFlight.size;
  }

  /**
   * Runs a task after the current turn of the event loop, so the 202 is
   * already on the wire before the fan-out starts, and never rejects to
   * the caller.
   */
  run(traceId: string, task: () => Promise<void>): void {
    const tracked = deferred()
      .then(task)
      .catch((error: unknown) => {
        const failure = toAppError(error);
        this.#logger.withTraceId(traceId).error('webhook work failed', {
          code: failure.code,
          status: failure.status,
          message: failure.message,
        });
      })
      .finally(() => {
        this.#inFlight.delete(tracked);
      });
    this.#inFlight.add(tracked);
  }

  /** Waits for everything in flight, including work queued meanwhile. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
}

export interface WebhookAccepted {
  readonly status: 202;
  readonly body: { readonly accepted: true; readonly traceId: string };
}

/**
 * Authenticates and validates one delivery, queues the fan-out and
 * returns the acknowledgement. Throws an `AppError` the route turns into
 * the standard error body; nothing here writes to the socket itself, so
 * it is testable without Fastify.
 */
export function acceptWorkItemUpdated(
  request: WebhookRequest,
  auth: WebhookAuth,
  deps: WorkItemUpdatedDeps,
  queue: WebhookWorkQueue,
  options: CallOptions,
): WebhookAccepted {
  const log = deps.logger.withTraceId(options.traceId);
  const verified = verifyWebhookRequest(auth, request.headers);
  if (!verified.ok) {
    log.warn('webhook delivery rejected', { reason: verified.reason });
    throw new UnauthorizedError('Webhook credentials are not valid.', {
      details: { reason: verified.reason },
    });
  }

  const parsed = adoWorkItemUpdatedEventSchema.safeParse(request.body);
  if (!parsed.success) {
    log.warn('webhook payload rejected', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    throw new ValidationError('Webhook payload is not a workitem.updated.', {
      details: { issueCount: parsed.error.issues.length },
    });
  }

  const event = parsed.data;

  // A delivery is the only proof that matters: a subscription that exists
  // but cannot reach us is worse than none. Azure DevOps will not tell us
  // its subscriptions without a scope the read-only service token does
  // not carry, so the service learns from being called.
  const projectId = event.resourceContainers?.project?.id;
  if (projectId !== undefined && event.subscriptionId !== undefined) {
    deps.hooks?.markSubscribed(projectId, event.subscriptionId);
  }

  queue.run(options.traceId, async () => {
    await processWorkItemUpdated(event, deps, options);
  });
  return { status: 202, body: { accepted: true, traceId: options.traceId } };
}
