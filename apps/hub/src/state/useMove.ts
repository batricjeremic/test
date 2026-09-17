/**
 * `useMove` — the optimistic write, which is the heart of the product.
 *
 * The contract, straight from the spec's write path:
 *
 *  - the card moves immediately and is LOCKED with a spinner;
 *  - the move carries the rev the card was showing;
 *  - on success the card is unlocked with the rev Azure DevOps returned;
 *  - on ANY failure the card snaps back to exactly where it was and the
 *    typed reason is surfaced as a toast;
 *  - a move is never shown as saved until the BFF confirms it. There is
 *    no queue, nothing is retried silently, nothing is swallowed.
 *
 * Concurrent drags of different cards are independent: each move holds
 * its own overlay entry keyed by work item id, so one rollback cannot
 * disturb another card, and a rollback restores the exact prior position
 * even if the board changed underneath it.
 */
import { useCallback, useMemo } from 'react';
import type { BoardCard, MoveFailure, MoveRequest } from '@eg/shared';
import { newTraceId, toMoveFailure, useApiClient } from '../api';
import type { BoardApiClient } from '../api';
import { useBoardContext } from './BoardProvider';
import type { PendingMove } from './boardStore';
import { useToasts } from './ToastProvider';

/** One drag, as the board view reports it. */
export type MoveCardInput = {
  /** The card as the user sees it, carrying the rev they were shown. */
  card: BoardCard;
  toCanonicalColumnId: string;
  /** Column name, used in the failure toast. */
  toColumnName?: string;
  /** Team name, used in the mapping-missing toast. */
  teamName?: string;
  /** Project name, used in the permission-denied toast. */
  projectName?: string;
  /** False suppresses the toast; the caller renders the reason itself. */
  toast?: boolean;
};

export type MoveOutcome =
  | { status: 'applied'; card: BoardCard; stateChanged: boolean }
  | { status: 'failed'; failure: MoveFailure }
  | {
      status: 'ignored';
      reason: 'already-moving' | 'same-column' | 'not-loaded';
    };

export type UseMoveResult = {
  /**
   * Moves a card. Resolves once the BFF has answered — `applied` only
   * ever means Azure DevOps confirmed the write.
   */
  moveCard(input: MoveCardInput): Promise<MoveOutcome>;
  /** Cards with a move in flight, keyed by work item id. */
  pendingMoves: ReadonlyMap<number, PendingMove>;
  /** True while this card is locked: render a spinner, refuse a drag. */
  isCardLocked(workItemId: number): boolean;
  isMoving: boolean;
};

export type UseMoveOptions = {
  /** Overrides the client from `ApiProvider`. */
  client?: BoardApiClient;
  /** Injected in tests to make move ids deterministic. */
  newMoveId?: () => string;
};

export function useMove(options: UseMoveOptions = {}): UseMoveResult {
  const board = useBoardContext();
  const contextClient = useApiClient();
  const client = options.client ?? contextClient;
  const toasts = useToasts();
  const newMoveId = options.newMoveId ?? newTraceId;

  const { store, boardId, refetch } = board;

  const moveCard = useCallback(
    async (input: MoveCardInput): Promise<MoveOutcome> => {
      const { card, toCanonicalColumnId } = input;

      if (card.canonicalColumnId === toCanonicalColumnId) {
        return { status: 'ignored', reason: 'same-column' };
      }
      if (store.getState().snapshot === null) {
        return { status: 'ignored', reason: 'not-loaded' };
      }

      // One id for the drag, the store entry and the correlation header,
      // so a hub action and its BFF log line and audit row all match.
      const moveId = newMoveId();
      const pending: PendingMove = {
        moveId,
        workItemId: card.workItemId,
        fromCanonicalColumnId: card.canonicalColumnId,
        toCanonicalColumnId,
        rev: card.rev,
        startedAt: Date.now(),
      };

      if (!store.beginMove(pending)) {
        return { status: 'ignored', reason: 'already-moving' };
      }

      const request: MoveRequest = {
        boardId,
        workItemId: card.workItemId,
        rev: card.rev,
        fromCanonicalColumnId: card.canonicalColumnId,
        toCanonicalColumnId,
      };

      const context = {
        card,
        canonicalColumnId: toCanonicalColumnId,
        ...(input.toColumnName === undefined
          ? {}
          : { canonicalColumnName: input.toColumnName }),
        ...(input.teamName === undefined ? {} : { teamName: input.teamName }),
        ...(input.projectName === undefined
          ? {}
          : { projectName: input.projectName }),
      };

      let failure: MoveFailure;
      try {
        const result = await client.moveCard(request, {
          traceId: moveId,
          context,
        });

        if (result.status === 'applied') {
          store.commitMove(moveId, result.card);
          return {
            status: 'applied',
            card: result.card,
            stateChanged: result.stateChanged,
          };
        }

        store.rollbackMove(moveId, result.card);
        failure = result.failure;
      } catch (error) {
        // The real client never throws; a fake or a programming error
        // still must not leave the card locked.
        store.rollbackMove(moveId, null);
        failure = toMoveFailure(error, context);
      }

      if (input.toast !== false) {
        toasts.pushMoveFailure(failure, card.workItemId);
      }
      if (failure.reason === 'revision-conflict') {
        // The card changed under the user: take the board's word for it.
        void refetch();
      }
      return { status: 'failed', failure };
    },
    [store, boardId, client, newMoveId, toasts, refetch],
  );

  return useMemo(
    () => ({
      moveCard,
      pendingMoves: board.pendingMoves,
      isCardLocked: board.isCardLocked,
      isMoving: board.pendingMoves.size > 0,
    }),
    [moveCard, board.pendingMoves, board.isCardLocked],
  );
}
