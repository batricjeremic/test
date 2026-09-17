/**
 * The board store.
 *
 * One plain observable store, read through `useSyncExternalStore`. No
 * state library is installed and none is needed; what this buys over
 * `useState` is that a move's begin/commit/rollback can be applied from
 * an async callback without reading a stale closure, which is exactly
 * where an optimistic write path goes wrong.
 *
 * The invariant: `snapshot.cards` is what the BFF has confirmed, and
 * `pendingMoves` is a per-card overlay on top of it. A rollback deletes
 * the overlay entry, so the card lands back on the confirmed truth at its
 * original index — even if other cards moved in the meantime, and even if
 * a realtime delta arrived for the same card while the move was in
 * flight.
 */
import type { BoardCard, BoardSnapshot, CardDelta } from '@eg/shared';

export type BoardStatus = 'idle' | 'loading' | 'ready' | 'error';

/** A move the BFF has not answered yet. Its card is locked. */
export type PendingMove = {
  /** Unique per drag, so a late answer cannot land on a newer move. */
  readonly moveId: string;
  readonly workItemId: number;
  /** Where the card sat before the drag. Not used for rollback — the
   *  confirmed snapshot is — but shown in the toast and the audit trail. */
  readonly fromCanonicalColumnId: string;
  readonly toCanonicalColumnId: string;
  /** The rev the user's card carried when the drag started. */
  readonly rev: number;
  readonly startedAt: number;
};

export type BoardStoreState = {
  status: BoardStatus;
  /** What the BFF confirmed, with realtime deltas applied. */
  snapshot: BoardSnapshot | null;
  /** Confirmed cards with pending moves laid over them, in snapshot order. */
  cards: readonly BoardCard[];
  cardsById: ReadonlyMap<number, BoardCard>;
  /** Keyed by work item id: present means locked, spinner showing. */
  pendingMoves: ReadonlyMap<number, PendingMove>;
  error: Error | null;
  /** Epoch ms of the last successful load. */
  loadedAt: number | null;
};

export interface BoardStore {
  getState(): BoardStoreState;
  subscribe(listener: () => void): () => void;
  loadStarted(): void;
  loadSucceeded(snapshot: BoardSnapshot): void;
  loadFailed(error: Error): void;
  /** Applies one realtime delta to the confirmed snapshot. */
  applyDelta(delta: CardDelta): void;
  /**
   * Locks the card and moves it optimistically. Returns false when the
   * card already has a move in flight or is not on the board, so two
   * drags of the same card can never queue up.
   */
  beginMove(move: PendingMove): boolean;
  /** The BFF confirmed: adopt its card, with the new rev, and unlock. */
  commitMove(moveId: string, card: BoardCard): void;
  /**
   * Any failure: drop the overlay so the card snaps back exactly where it
   * was, and adopt the authoritative card when the BFF sent one (a
   * revision conflict refreshes the card in place).
   */
  rollbackMove(moveId: string, authoritative?: BoardCard | null): void;
  reset(): void;
}

const EMPTY_PENDING: ReadonlyMap<number, PendingMove> = new Map();

export const INITIAL_BOARD_STATE: BoardStoreState = {
  status: 'idle',
  snapshot: null,
  cards: [],
  cardsById: new Map(),
  pendingMoves: EMPTY_PENDING,
  error: null,
  loadedAt: null,
};

export function createBoardStore(
  initial: BoardSnapshot | null = null,
): BoardStore {
  const listeners = new Set<() => void>();
  let confirmed: BoardCard[] = initial?.cards ?? [];
  let pending = new Map<number, PendingMove>();
  let state: BoardStoreState = initial
    ? derive('ready', initial, confirmed, pending, null, Date.now())
    : INITIAL_BOARD_STATE;

  const publish = (next: BoardStoreState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  const rebuild = (
    status: BoardStatus = state.status,
    error: Error | null = state.error,
  ): void => {
    publish(
      derive(status, state.snapshot, confirmed, pending, error, state.loadedAt),
    );
  };

  const replaceConfirmed = (card: BoardCard): void => {
    const index = confirmed.findIndex(
      (candidate) => candidate.workItemId === card.workItemId,
    );
    confirmed =
      index === -1
        ? [...confirmed, card]
        : confirmed.map((candidate, at) => (at === index ? card : candidate));
  };

  return {
    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    loadStarted: () => {
      rebuild('loading', null);
    },

    loadFailed: (error) => {
      rebuild('error', error);
    },

    loadSucceeded: (snapshot) => {
      confirmed = snapshot.cards;
      // A card the server no longer knows about cannot have a move in
      // flight against it; drop those locks rather than stranding them.
      pending = new Map(
        [...pending].filter(([workItemId]) =>
          confirmed.some((card) => card.workItemId === workItemId),
        ),
      );
      publish(derive('ready', snapshot, confirmed, pending, null, Date.now()));
    },

    applyDelta: (delta) => {
      if (!state.snapshot) return;
      switch (delta.kind) {
        case 'card-upserted': {
          replaceConfirmed(delta.card);
          break;
        }
        case 'card-moved': {
          const existing = confirmed.find(
            (card) => card.workItemId === delta.workItemId,
          );
          if (!existing) return;
          replaceConfirmed({
            ...existing,
            canonicalColumnId: delta.toCanonicalColumnId,
            sourceColumn: delta.sourceColumn,
            state: delta.state,
            assignedTo: delta.assignedTo,
            rev: delta.rev,
          });
          break;
        }
        case 'card-removed': {
          confirmed = confirmed.filter(
            (card) => card.workItemId !== delta.workItemId,
          );
          break;
        }
      }
      rebuild();
    },

    beginMove: (move) => {
      if (pending.has(move.workItemId)) return false;
      const exists = confirmed.some(
        (card) => card.workItemId === move.workItemId,
      );
      if (!exists) return false;
      pending = new Map(pending).set(move.workItemId, move);
      rebuild();
      return true;
    },

    commitMove: (moveId, card) => {
      const entry = findMove(pending, moveId);
      if (!entry) return;
      pending = withoutMove(pending, moveId);
      replaceConfirmed(card);
      rebuild();
    },

    rollbackMove: (moveId, authoritative = null) => {
      const entry = findMove(pending, moveId);
      if (!entry) return;
      pending = withoutMove(pending, moveId);
      if (authoritative) replaceConfirmed(authoritative);
      rebuild();
    },

    reset: () => {
      confirmed = [];
      pending = new Map();
      publish(INITIAL_BOARD_STATE);
    },
  };
}

function findMove(
  pending: ReadonlyMap<number, PendingMove>,
  moveId: string,
): PendingMove | null {
  for (const move of pending.values()) {
    if (move.moveId === moveId) return move;
  }
  return null;
}

function withoutMove(
  pending: ReadonlyMap<number, PendingMove>,
  moveId: string,
): Map<number, PendingMove> {
  const next = new Map(pending);
  for (const [workItemId, move] of next) {
    if (move.moveId === moveId) next.delete(workItemId);
  }
  return next;
}

/**
 * Lays the pending overlay over the confirmed cards, preserving order so
 * a rolled-back card returns to the exact index it left.
 */
function derive(
  status: BoardStatus,
  snapshot: BoardSnapshot | null,
  confirmed: BoardCard[],
  pending: ReadonlyMap<number, PendingMove>,
  error: Error | null,
  loadedAt: number | null,
): BoardStoreState {
  const cards =
    pending.size === 0
      ? confirmed
      : confirmed.map((card) => {
          const move = pending.get(card.workItemId);
          return move
            ? { ...card, canonicalColumnId: move.toCanonicalColumnId }
            : card;
        });

  const cardsById = new Map<number, BoardCard>();
  for (const card of cards) cardsById.set(card.workItemId, card);

  const nextSnapshot =
    snapshot === null
      ? null
      : snapshot.cards === confirmed
        ? snapshot
        : { ...snapshot, cards: confirmed };

  return {
    status,
    snapshot: nextSnapshot,
    cards,
    cardsById,
    pendingMoves: pending,
    error,
    loadedAt,
  };
}
