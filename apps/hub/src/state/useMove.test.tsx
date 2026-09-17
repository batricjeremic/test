/**
 * The write path, tested against the spec's failure table row for row.
 *
 * Every case asserts the same three things: the card came back to where
 * it started, it is unlocked, and the user was told the typed reason.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  DEFAULT_ITERATION_ALIGNMENT,
  EMPTY_BOARD_FILTER_SET,
} from '@eg/shared';
import type { BoardCard, MoveFailure } from '@eg/shared';
import {
  ApiClientError,
  ApiProvider,
  createFakeBoardApiClient,
  FIXTURE_BOARD_ID,
  makeBoardSnapshot,
} from '../api';
import type { FakeBoardApiClient } from '../api';
import { BoardProvider, useBoardContext } from './BoardProvider';
import { ToastProvider, useToasts } from './ToastProvider';
import { useMove } from './useMove';

type Harness = {
  board: ReturnType<typeof useBoardContext>;
  move: ReturnType<typeof useMove>;
  toasts: ReturnType<typeof useToasts>;
};

function renderHarness(client: FakeBoardApiClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider client={client}>
      <ToastProvider>
        <BoardProvider
          boardId={FIXTURE_BOARD_ID}
          alignment={DEFAULT_ITERATION_ALIGNMENT}
          filters={EMPTY_BOARD_FILTER_SET}
          options={{ realtime: false }}
        >
          {children}
        </BoardProvider>
      </ToastProvider>
    </ApiProvider>
  );

  return renderHook<Harness, void>(
    () => ({
      board: useBoardContext(),
      move: useMove(),
      toasts: useToasts(),
    }),
    { wrapper },
  );
}

async function renderReadyBoard(client = createFakeBoardApiClient()) {
  const view = renderHarness(client);
  await waitFor(() => {
    expect(view.result.current.board.status).toBe('ready');
  });
  return view;
}

function cardOf(
  view: Awaited<ReturnType<typeof renderReadyBoard>>,
  workItemId: number,
): BoardCard {
  const card = view.result.current.board.cardsById.get(workItemId);
  if (!card) throw new Error(`No card ${workItemId} on the board`);
  return card;
}

const revisionConflict: MoveFailure = {
  reason: 'revision-conflict',
  message: 'Ana moved this to Done a moment ago',
  currentRev: 9,
  currentCanonicalColumnId: 'col-done',
  currentColumnName: 'Done',
  changedBy: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
  changedAt: '2026-09-17T09:00:00.000Z',
};

const ruleViolation: MoveFailure = {
  reason: 'rule-violation',
  message: 'Activity is required before this can move to Active',
  field: 'Microsoft.VSTS.Common.Activity',
  fieldDisplayName: 'Activity',
  targetState: 'Active',
  workItemUrl:
    'https://dev.azure.com/expertgroup/Delivery/_workitems/edit/1001',
};

const transitionNotAllowed: MoveFailure = {
  reason: 'transition-not-allowed',
  message: '',
  fromState: 'New',
  toState: 'Closed',
  allowedStates: ['Active', 'Resolved'],
};

const permissionDenied: MoveFailure = {
  reason: 'permission-denied',
  message: '',
  projectId: 'Data and AI',
  projectName: 'Data and AI',
};

const mappingMissing: MoveFailure = {
  reason: 'mapping-missing',
  message: '',
  projectId: 'Delivery',
  teamId: 'team-dev',
  teamName: 'Dev',
  canonicalColumnId: 'col-review',
  canonicalColumnName: 'In review',
};

const serviceUnavailable: MoveFailure = {
  reason: 'service-unavailable',
  message: '',
  attempts: 3,
  retryAfterSeconds: 12,
};

describe('useMove', () => {
  it('moves the card, locks it, and unlocks with the new rev', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const before = cardOf(view, 1001);
    const deferred = client.deferNextMove();

    let outcome: Promise<unknown> | null = null;
    await act(async () => {
      outcome = view.result.current.move.moveCard({
        card: before,
        toCanonicalColumnId: 'col-review',
      });
      await deferred.sent;
    });

    // Optimistic: already in the new column, locked, spinner showing.
    expect(cardOf(view, 1001).canonicalColumnId).toBe('col-review');
    expect(view.result.current.move.isCardLocked(1001)).toBe(true);
    expect(view.result.current.move.isMoving).toBe(true);

    await act(async () => {
      deferred.resolve({
        status: 'applied',
        workItemId: 1001,
        card: {
          ...before,
          canonicalColumnId: 'col-review',
          rev: before.rev + 1,
        },
        stateChanged: true,
      });
      await outcome;
    });

    const after = cardOf(view, 1001);
    expect(after.canonicalColumnId).toBe('col-review');
    expect(after.rev).toBe(before.rev + 1);
    expect(view.result.current.move.isCardLocked(1001)).toBe(false);
    expect(view.result.current.toasts.toasts).toHaveLength(0);
  });

  it('sends the rev the card was showing', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const card = cardOf(view, 1001);

    await act(async () => {
      await view.result.current.move.moveCard({
        card,
        toCanonicalColumnId: 'col-done',
      });
    });

    expect(client.moveRequests).toHaveLength(1);
    expect(client.moveRequests[0]).toMatchObject({
      boardId: FIXTURE_BOARD_ID,
      workItemId: 1001,
      rev: card.rev,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-done',
    });
  });

  const failures: [string, MoveFailure][] = [
    ['revision conflict', revisionConflict],
    ['rule violation', ruleViolation],
    ['transition not allowed', transitionNotAllowed],
    ['permission denied', permissionDenied],
    ['mapping missing', mappingMissing],
    ['service unavailable', serviceUnavailable],
  ];

  it.each(failures)(
    'rolls back and reports the reason: %s',
    async (_label, failure) => {
      const client = createFakeBoardApiClient();
      const view = await renderReadyBoard(client);
      const before = cardOf(view, 1001);
      client.failNextMove(failure);

      let outcome: unknown;
      await act(async () => {
        outcome = await view.result.current.move.moveCard({
          card: before,
          toCanonicalColumnId: 'col-review',
        });
      });

      expect(outcome).toEqual({ status: 'failed', failure });

      const after = cardOf(view, 1001);
      expect(after.canonicalColumnId).toBe(before.canonicalColumnId);
      expect(after.rev).toBe(before.rev);
      expect(view.result.current.move.isCardLocked(1001)).toBe(false);
      expect(view.result.current.move.isMoving).toBe(false);

      const toasts = view.result.current.toasts.toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.reason).toBe(failure.reason);
      expect(toasts[0]?.workItemId).toBe(1001);
      expect(toasts[0]?.message.length).toBeGreaterThan(0);
    },
  );

  it('refetches the board after a revision conflict', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const loadsBefore = client.snapshotRequests.length;
    client.failNextMove(revisionConflict);

    await act(async () => {
      await view.result.current.move.moveCard({
        card: cardOf(view, 1001),
        toCanonicalColumnId: 'col-review',
      });
    });

    await waitFor(() => {
      expect(client.snapshotRequests.length).toBe(loadsBefore + 1);
    });
  });

  it('adopts the authoritative card the BFF sends with a failure', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const before = cardOf(view, 1001);
    client.failNextMove(mappingMissing, {
      ...before,
      canonicalColumnId: 'col-done',
      rev: 9,
    });

    await act(async () => {
      await view.result.current.move.moveCard({
        card: before,
        toCanonicalColumnId: 'col-review',
      });
    });

    const after = cardOf(view, 1001);
    expect(after.canonicalColumnId).toBe('col-done');
    expect(after.rev).toBe(9);
  });

  it('maps a transport failure onto a typed reason', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    client.throwOnNextMove(
      new ApiClientError({
        kind: 'timeout',
        message: 'Request timed out after 10000ms',
        traceId: 'trace-1',
      }),
    );

    let outcome: { status: string; failure?: MoveFailure } | undefined;
    await act(async () => {
      outcome = (await view.result.current.move.moveCard({
        card: cardOf(view, 1001),
        toCanonicalColumnId: 'col-review',
      })) as { status: string; failure?: MoveFailure };
    });

    expect(outcome?.status).toBe('failed');
    expect(outcome?.failure?.reason).toBe('service-unavailable');
    expect(cardOf(view, 1001).canonicalColumnId).toBe('col-doing');
  });

  it('refuses a second drag of a card that is already moving', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const card = cardOf(view, 1001);
    const deferred = client.deferNextMove();

    let first: Promise<unknown> | null = null;
    await act(async () => {
      first = view.result.current.move.moveCard({
        card,
        toCanonicalColumnId: 'col-review',
      });
      await deferred.sent;
    });

    let second: unknown;
    await act(async () => {
      second = await view.result.current.move.moveCard({
        card,
        toCanonicalColumnId: 'col-done',
      });
    });

    expect(second).toEqual({ status: 'ignored', reason: 'already-moving' });
    expect(client.moveRequests).toHaveLength(1);

    await act(async () => {
      deferred.resolve({
        status: 'applied',
        workItemId: 1001,
        card: { ...card, canonicalColumnId: 'col-review', rev: card.rev + 1 },
        stateChanged: false,
      });
      await first;
    });
  });

  it('ignores a drop back onto the same column', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const card = cardOf(view, 1001);

    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.move.moveCard({
        card,
        toCanonicalColumnId: card.canonicalColumnId,
      });
    });

    expect(outcome).toEqual({ status: 'ignored', reason: 'same-column' });
    expect(client.moveRequests).toHaveLength(0);
  });

  it('keeps concurrent drags of different cards independent', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const first = cardOf(view, 1001);
    const second = cardOf(view, 1002);

    const deferredFirst = client.deferNextMove();
    const deferredSecond = client.deferNextMove();

    let firstMove: Promise<unknown> | null = null;
    let secondMove: Promise<unknown> | null = null;
    await act(async () => {
      firstMove = view.result.current.move.moveCard({
        card: first,
        toCanonicalColumnId: 'col-review',
      });
      await deferredFirst.sent;
      secondMove = view.result.current.move.moveCard({
        card: second,
        toCanonicalColumnId: 'col-done',
      });
      await deferredSecond.sent;
    });

    expect(view.result.current.move.pendingMoves.size).toBe(2);

    // The second card lands first and stays put.
    await act(async () => {
      deferredSecond.resolve({
        status: 'applied',
        workItemId: 1002,
        card: { ...second, canonicalColumnId: 'col-done', rev: second.rev + 1 },
        stateChanged: false,
      });
      await secondMove;
    });

    // The first one fails and must snap back to its own original column,
    // without disturbing the card that moved in the meantime.
    await act(async () => {
      deferredFirst.resolve({
        status: 'failed',
        workItemId: 1001,
        failure: serviceUnavailable,
        card: null,
      });
      await firstMove;
    });

    expect(cardOf(view, 1001).canonicalColumnId).toBe('col-doing');
    expect(cardOf(view, 1002).canonicalColumnId).toBe('col-done');
    expect(view.result.current.move.pendingMoves.size).toBe(0);

    // And the rolled-back card is back at its exact index.
    expect(
      view.result.current.board.cards.map((card) => card.workItemId),
    ).toEqual([1001, 1002]);
  });

  it('never reports a move as saved without a confirmation', async () => {
    const client = createFakeBoardApiClient();
    const view = await renderReadyBoard(client);
    const card = cardOf(view, 1001);
    const deferred = client.deferNextMove();

    let pending: Promise<unknown> | null = null;
    await act(async () => {
      pending = view.result.current.move.moveCard({
        card,
        toCanonicalColumnId: 'col-review',
      });
      await deferred.sent;
    });

    // While in flight the card is locked: not saved, not lost.
    expect(view.result.current.move.isCardLocked(1001)).toBe(true);
    expect(cardOf(view, 1001).rev).toBe(card.rev);

    await act(async () => {
      deferred.resolve({
        status: 'failed',
        workItemId: 1001,
        failure: serviceUnavailable,
        card: null,
      });
      await pending;
    });

    expect(cardOf(view, 1001).canonicalColumnId).toBe('col-doing');
    expect(view.result.current.move.isCardLocked(1001)).toBe(false);
  });

  it('suppresses the toast when the caller asks to render it itself', async () => {
    const client = createFakeBoardApiClient({
      snapshot: makeBoardSnapshot(),
    });
    const view = await renderReadyBoard(client);
    client.failNextMove(serviceUnavailable);

    await act(async () => {
      await view.result.current.move.moveCard({
        card: cardOf(view, 1001),
        toCanonicalColumnId: 'col-review',
        toast: false,
      });
    });

    expect(view.result.current.toasts.toasts).toHaveLength(0);
  });
});
