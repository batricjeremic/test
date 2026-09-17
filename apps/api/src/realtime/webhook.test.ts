import { describe, expect, it, vi } from 'vitest';
import type { RealtimeEnvelope } from '@eg/shared';
import { ADO_FIELDS } from '../ado/types.js';
import type { CacheInvalidator } from '../cache/invalidation.js';
import { isAppError } from '../errors.js';
import type { CallOptions } from '../ports.js';
import type { PublishDeltaInput } from './hub.js';
import {
  acceptWorkItemUpdated,
  processWorkItemUpdated,
  removalCause,
  WebhookWorkQueue,
  type DeltaPublisher,
  type WebhookCardLookup,
  type WorkItemUpdatedDeps,
} from './webhook.js';
import type { WebhookAuth } from './verify.js';
import { RecordingLogger, sampleCard, sampleEvent } from './test-support.js';

const options: CallOptions = { traceId: 'trace-hook' };

const auth: WebhookAuth = {
  kind: 'shared-secret',
  headerName: 'x-eg-hook-secret',
  secret: 'a-secret-of-sufficient-length',
};

const goodHeaders = { 'x-eg-hook-secret': auth.secret };

class FakeInvalidator implements CacheInvalidator {
  boards: string[] = [];
  readonly invalidatedWorkItems: number[] = [];
  failure: Error | null = null;

  async invalidateBoard(): Promise<number> {
    return 0;
  }
  async invalidateBoardSnapshots(): Promise<number> {
    return 0;
  }
  async invalidateWorkItem(workItemId: number): Promise<readonly string[]> {
    if (this.failure !== null) throw this.failure;
    this.invalidatedWorkItems.push(workItemId);
    return this.boards;
  }
  async invalidateTeamSettings(): Promise<number> {
    return 0;
  }
  async invalidateOrgDirectory(): Promise<number> {
    return 0;
  }
  async flushBoardColumns(): Promise<number> {
    return 0;
  }
  async rememberWorkItems(): Promise<void> {}
}

class FakePublisher implements DeltaPublisher {
  readonly published: PublishDeltaInput[] = [];
  subscribers = new Map<string, number>();

  subscriberCount(boardId: string): number {
    return this.subscribers.get(boardId) ?? 1;
  }

  async publishDelta(input: PublishDeltaInput): Promise<RealtimeEnvelope> {
    this.published.push(input);
    return {
      v: 1,
      boardId: input.boardId,
      channel: `board:${input.boardId}`,
      sequence: this.published.length,
      emittedAt: '2026-09-17T08:00:00.000Z',
      traceId: input.traceId,
      origin: input.origin,
      delta: input.delta,
    };
  }
}

const lookupReturning = (card: ReturnType<typeof sampleCard> | null) =>
  ({
    lookup: vi.fn(async () => card),
  }) satisfies WebhookCardLookup;

const makeDeps = (
  overrides: Partial<WorkItemUpdatedDeps> = {},
): {
  deps: WorkItemUpdatedDeps;
  invalidator: FakeInvalidator;
  publisher: FakePublisher;
  logger: RecordingLogger;
} => {
  const invalidator = new FakeInvalidator();
  const publisher = new FakePublisher();
  const logger = new RecordingLogger();
  return {
    deps: {
      logger,
      invalidator,
      publisher,
      cards: lookupReturning(sampleCard()),
      ...overrides,
    },
    invalidator,
    publisher,
    logger,
  };
};

describe('removalCause', () => {
  it('reads a resprint out of the changed fields', () => {
    expect(
      removalCause(
        sampleEvent({ [ADO_FIELDS.iterationPath]: { newValue: 'P\\S2' } }),
      ),
    ).toBe('iteration-changed');
  });

  it('reports anything else as out of scope rather than guessing', () => {
    expect(
      removalCause(
        sampleEvent({ [ADO_FIELDS.areaPath]: { newValue: 'P\\X' } }),
      ),
    ).toBe('out-of-scope');
    expect(removalCause(sampleEvent())).toBe('out-of-scope');
  });
});

describe('processWorkItemUpdated', () => {
  it('invalidates the boards holding the card and pushes a delta', async () => {
    const { deps, invalidator, publisher } = makeDeps();
    invalidator.boards = ['board-1', 'board-2'];

    const result = await processWorkItemUpdated(
      sampleEvent({ 'System.State': { newValue: 'Done' } }),
      deps,
      options,
    );

    expect(invalidator.invalidatedWorkItems).toEqual([42]);
    expect(result).toMatchObject({ workItemId: 42, published: 2, skipped: 0 });
    expect(publisher.published.map((input) => input.boardId)).toEqual([
      'board-1',
      'board-2',
    ]);
    expect(publisher.published[0]?.origin).toBe('service-hook');
    expect(publisher.published[0]?.delta).toEqual({
      kind: 'card-upserted',
      card: sampleCard(),
    });
  });

  it('emits a removal when the card has left the board', async () => {
    const { deps, invalidator, publisher } = makeDeps({
      cards: lookupReturning(null),
    });
    invalidator.boards = ['board-1'];

    await processWorkItemUpdated(
      sampleEvent({ [ADO_FIELDS.iterationPath]: { newValue: 'P\\S2' } }),
      deps,
      options,
    );

    expect(publisher.published[0]?.delta).toEqual({
      kind: 'card-removed',
      workItemId: 42,
      cause: 'iteration-changed',
    });
  });

  it('does not resolve a card for a board nobody is watching', async () => {
    const cards = lookupReturning(sampleCard());
    const { deps, invalidator, publisher } = makeDeps({ cards });
    invalidator.boards = ['board-1'];
    publisher.subscribers.set('board-1', 0);

    const result = await processWorkItemUpdated(sampleEvent(), deps, options);

    expect(cards.lookup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ published: 0, skipped: 1 });
  });

  it('still invalidates, and says so, with no card lookup configured', async () => {
    const { deps, invalidator, publisher, logger } = makeDeps({
      cards: undefined,
    });
    invalidator.boards = ['board-1'];

    const result = await processWorkItemUpdated(sampleEvent(), deps, options);

    expect(invalidator.invalidatedWorkItems).toEqual([42]);
    expect(publisher.published).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(
      logger.matching(
        'no card lookup configured, open boards will poll instead',
      ),
    ).toHaveLength(1);
  });
});

describe('acceptWorkItemUpdated', () => {
  it('rejects a delivery whose credentials do not match', async () => {
    const { deps, invalidator } = makeDeps();
    const queue = new WebhookWorkQueue(deps.logger);

    let caught: unknown;
    try {
      acceptWorkItemUpdated(
        { headers: { 'x-eg-hook-secret': 'wrong' }, body: sampleEvent() },
        auth,
        deps,
        queue,
        options,
      );
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught) ? caught.status : 0).toBe(401);
    await queue.drain();
    expect(invalidator.invalidatedWorkItems).toEqual([]);
  });

  it('rejects an unsigned delivery before reading the body', async () => {
    const { deps, invalidator } = makeDeps();
    const queue = new WebhookWorkQueue(deps.logger);

    expect(() =>
      acceptWorkItemUpdated(
        { headers: {}, body: sampleEvent() },
        auth,
        deps,
        queue,
        options,
      ),
    ).toThrow();
    await queue.drain();
    expect(invalidator.invalidatedWorkItems).toEqual([]);
  });

  it('rejects a payload that is not a workitem.updated document', () => {
    const { deps } = makeDeps();
    const queue = new WebhookWorkQueue(deps.logger);

    let caught: unknown;
    try {
      acceptWorkItemUpdated(
        { headers: goodHeaders, body: { eventType: 'workitem.deleted' } },
        auth,
        deps,
        queue,
        options,
      );
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught) ? caught.status : 0).toBe(400);
  });

  it('acknowledges a valid delivery, then invalidates and publishes', async () => {
    const { deps, invalidator, publisher } = makeDeps();
    invalidator.boards = ['board-1'];
    const queue = new WebhookWorkQueue(deps.logger);

    const accepted = acceptWorkItemUpdated(
      { headers: goodHeaders, body: sampleEvent() },
      auth,
      deps,
      queue,
      options,
    );

    // The answer goes out before the work runs.
    expect(accepted).toEqual({
      status: 202,
      body: { accepted: true, traceId: 'trace-hook' },
    });
    expect(invalidator.invalidatedWorkItems).toEqual([]);

    await queue.drain();

    expect(invalidator.invalidatedWorkItems).toEqual([42]);
    expect(publisher.published).toHaveLength(1);
  });
});

describe('WebhookWorkQueue', () => {
  it('logs a failure with the trace id instead of swallowing it', async () => {
    const logger = new RecordingLogger();
    const queue = new WebhookWorkQueue(logger);

    queue.run('trace-hook', async () => {
      throw new Error('redis is down');
    });
    expect(queue.pending).toBe(1);
    await queue.drain();

    expect(queue.pending).toBe(0);
    expect(logger.matching('webhook work failed')).toHaveLength(1);
  });

  it('drains work queued while draining', async () => {
    const logger = new RecordingLogger();
    const queue = new WebhookWorkQueue(logger);
    const done: string[] = [];

    queue.run('trace-hook', async () => {
      done.push('first');
      queue.run('trace-hook', async () => {
        done.push('second');
      });
    });
    await queue.drain();

    expect(done).toEqual(['first', 'second']);
    expect(queue.pending).toBe(0);
  });
});
