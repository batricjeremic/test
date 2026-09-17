/**
 * The drag and drop brain.
 *
 * Refusals are decided before the drop, not after it: a column the card's
 * team has no mapping row for is blocked from drag start, a card in a
 * read-only project is never draggable, and a card with a move in flight
 * is locked. A drop that survives all of that goes to `useMove`, which
 * owns the optimistic write and the rollback.
 *
 * `BoardScreen` uses this hook; tests drive the same handlers directly,
 * because a synthetic pointer drag in jsdom proves nothing this does not.
 */
import { useCallback, useMemo, useState } from 'react';
import type {
  Announcements,
  DragEndEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import type {
  BoardCard,
  BoardTeamView,
  CanonicalColumn,
  MoveFailure,
} from '@eg/shared';
import {
  describeMoveFailure,
  evaluateDrop,
  isCardDragData,
  isColumnDropData,
  useBoardContext,
  useMove,
  useToasts,
} from '../state';
import type {
  CardDragData,
  ColumnDropData,
  DropDecision,
  DropRefusalReason,
} from '../types';
import { describeCard } from './format';

/**
 * A drop is a column change, never a lane change: reassigning is done in
 * the work item form, so a cross-lane drop is refused rather than
 * silently reinterpreted.
 */
export type BoardDropRefusal = DropRefusalReason | 'other-lane';

export type BoardDropDecision =
  DropDecision | { readonly allowed: false; readonly reason: 'other-lane' };

/** The card currently in the air, plus everything the cells need. */
export type ActiveDrag = {
  readonly data: CardDragData;
  readonly card: BoardCard | null;
  readonly columnName: string;
};

export type UseBoardDndOptions = {
  /** Columns in render order, including the trailing unmapped one. */
  columns: readonly CanonicalColumn[];
  teams: readonly BoardTeamView[];
};

export type BoardDnd = {
  activeDrag: ActiveDrag | null;
  onDragStart(event: DragStartEvent): void;
  onDragEnd(event: DragEndEvent): void;
  onDragCancel(): void;
  /** May this card land on this cell? Used to paint the blocked state. */
  evaluate(drag: CardDragData, drop: ColumnDropData): BoardDropDecision;
  announcements: Announcements;
};

export function useBoardDnd(options: UseBoardDndOptions): BoardDnd {
  const { columns, teams } = options;
  const board = useBoardContext();
  const move = useMove();
  const toasts = useToasts();
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  const columnName = useCallback(
    (canonicalColumnId: string): string =>
      columns.find((column) => column.id === canonicalColumnId)?.name ??
      canonicalColumnId,
    [columns],
  );

  const { isCardLocked, cardsById } = board;

  const evaluate = useCallback(
    (drag: CardDragData, drop: ColumnDropData): BoardDropDecision => {
      if (drag.swimlaneId !== drop.swimlaneId) {
        return { allowed: false, reason: 'other-lane' };
      }
      return evaluateDrop(drag, drop, {
        locked: isCardLocked(drag.workItemId),
      });
    },
    [isCardLocked],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current;
      if (!isCardDragData(data)) return;
      setActiveDrag({
        data,
        card: cardsById.get(data.workItemId) ?? null,
        columnName: columnName(data.fromCanonicalColumnId),
      });
    },
    [cardsById, columnName],
  );

  const onDragCancel = useCallback(() => {
    setActiveDrag(null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      const drag = event.active.data.current;
      const drop = event.over?.data.current;
      if (!isCardDragData(drag)) return;
      if (!isColumnDropData(drop)) return;

      const decision = evaluate(drag, drop);
      if (!decision.allowed) {
        const failure = refusalFailure(decision.reason, drag, {
          drop,
          teams,
          columnName: columnName(drop.canonicalColumnId),
        });
        if (failure !== null) {
          toasts.push({ ...describeMoveFailure(failure), timeoutMs: 6_000 });
        }
        return;
      }

      const card = cardsById.get(drag.workItemId);
      if (card === undefined) return;
      const team = teams.find((candidate) => candidate.teamId === card.teamId);

      void move.moveCard({
        card,
        toCanonicalColumnId: drop.canonicalColumnId,
        toColumnName: columnName(drop.canonicalColumnId),
        ...(team === undefined
          ? {}
          : {
              teamName: team.iteration.teamName,
              projectName: team.iteration.projectName,
            }),
      });
    },
    [evaluate, cardsById, teams, move, columnName, toasts],
  );

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart({ active }) {
        const drag = active.data.current;
        if (!isCardDragData(drag)) return undefined;
        const card = cardsById.get(drag.workItemId);
        const name = columnName(drag.fromCanonicalColumnId);
        return card === undefined
          ? undefined
          : `Picked up ${describeCard(card, name)}. ` +
              'Use the arrow keys to choose a column, space to drop.';
      },
      onDragOver({ active, over }) {
        const drag = active.data.current;
        const drop = over?.data.current;
        if (!isCardDragData(drag) || !isColumnDropData(drop)) return undefined;
        const name = columnName(drop.canonicalColumnId);
        const decision = evaluate(drag, drop);
        if (decision.allowed) return `Over ${name}. Space to drop here.`;
        if (decision.reason === 'same-column') {
          return `Back over ${name}, where this card started.`;
        }
        return (
          `${name} cannot take this card: ` +
          `${refusalPhrase(decision.reason)}.`
        );
      },
      onDragEnd({ active, over }) {
        const drag = active.data.current;
        const drop = over?.data.current;
        if (!isCardDragData(drag)) return undefined;
        if (!isColumnDropData(drop)) return 'Drag cancelled, card put back.';
        const name = columnName(drop.canonicalColumnId);
        const decision = evaluate(drag, drop);
        return decision.allowed
          ? `Moving to ${name}. Saving.`
          : `Not moved: ${refusalPhrase(decision.reason)}.`;
      },
      onDragCancel() {
        return 'Drag cancelled, card put back.';
      },
    }),
    [cardsById, columnName, evaluate],
  );

  return useMemo(
    () => ({
      activeDrag,
      onDragStart,
      onDragEnd,
      onDragCancel,
      evaluate,
      announcements,
    }),
    [activeDrag, onDragStart, onDragEnd, onDragCancel, evaluate, announcements],
  );
}

/** Plain-language refusal, for the live region and the blocked tooltip. */
export function refusalPhrase(reason: BoardDropRefusal): string {
  switch (reason) {
    case 'not-writable':
      return 'you do not have write access to that project';
    case 'mapping-missing':
      return 'this team has no column mapped to it';
    case 'card-locked':
      return 'this card is still saving';
    case 'unmapped-lane':
      return 'the unmapped column is not a drop target';
    case 'same-column':
      return 'the card is already there';
    case 'other-lane':
      return 'a card can only move between columns, not between lanes';
    default:
      return 'that column is not available';
  }
}

type RefusalContext = {
  drop: ColumnDropData;
  teams: readonly BoardTeamView[];
  columnName: string;
};

/**
 * The typed failure behind a refused drop, so the toast uses the same
 * wording the BFF's own failures do. `same-column` and `unmapped-lane`
 * are silent: nothing went wrong, the card simply stayed.
 */
export function refusalFailure(
  reason: BoardDropRefusal,
  drag: CardDragData,
  context: RefusalContext,
): MoveFailure | null {
  const team = context.teams.find(
    (candidate) => candidate.teamId === drag.teamId,
  );
  switch (reason) {
    case 'mapping-missing':
      return {
        reason: 'mapping-missing',
        message: '',
        projectId: drag.projectId,
        teamId: drag.teamId,
        teamName: team?.iteration.teamName ?? drag.teamId,
        canonicalColumnId: context.drop.canonicalColumnId,
        canonicalColumnName: context.columnName,
      };
    case 'not-writable':
      return {
        reason: 'permission-denied',
        message: '',
        projectId: drag.projectId,
        projectName: team?.iteration.projectName ?? drag.projectId,
      };
    default:
      return null;
  }
}
