/**
 * One (lane, column) cell: the board's only drop target.
 *
 * A cell decides for itself whether the card currently in the air may
 * land on it, so an unmapped column is painted as blocked from drag
 * start rather than failing after the drop.
 */
import { memo, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type {
  BoardCard,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
} from '@eg/shared';
import type { ColumnDropData } from '../types';
import { BoardCardItem } from './BoardCardItem';
import { useActiveDrag } from './boardUi';
import type { BoardUi } from './boardUi';
import { refusalPhrase } from './useBoardDnd';

export type BoardCellProps = {
  ui: BoardUi;
  lane: BoardSwimlane;
  column: CanonicalColumn;
  cards: readonly BoardCard[];
  collapsed: boolean;
};

function BoardCellImpl({
  ui,
  lane,
  column,
  cards,
  collapsed,
}: BoardCellProps): JSX.Element {
  const dropData = useMemo<ColumnDropData>(
    () => ({
      kind: 'column',
      canonicalColumnId: column.id,
      swimlaneId: lane.id,
    }),
    [column.id, lane.id],
  );

  const { isOver, setNodeRef } = useDroppable({
    id: `cell:${lane.id}:${column.id}`,
    data: dropData,
  });

  const activeDrag = useActiveDrag();
  const decision =
    activeDrag === null ? null : ui.evaluate(activeDrag.data, dropData);

  // Everything the card cannot land on is striped, including the lanes
  // it does not belong to, so the only cells that look available are the
  // ones that are. Its own cell is not an error and is left alone.
  const blocked =
    decision !== null && !decision.allowed && decision.reason !== 'same-column';

  const dropState =
    decision?.allowed === true && isOver
      ? 'over'
      : blocked
        ? 'blocked'
        : undefined;

  const readOnly =
    cards.length > 0 && cards.every((card) => !writable(ui, card));

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      className="eg-board__cell"
      aria-label={`${lane.label}, ${column.name}, ${cards.length} cards`}
      {...(dropState === undefined ? {} : { 'data-drop': dropState })}
      {...(readOnly ? { 'data-readonly': 'true' } : {})}
      {...(blocked && decision !== null && !decision.allowed
        ? { title: `Cannot drop here: ${refusalPhrase(decision.reason)}` }
        : {})}
    >
      {collapsed ? (
        <span className="eg-count">{cards.length}</span>
      ) : (
        cards.map((card) => (
          <BoardCardItem
            key={card.workItemId}
            card={card}
            team={teamFor(ui, card.teamId)}
            laneId={lane.id}
            columnName={column.name}
            locked={ui.isCardLocked(card.workItemId)}
            showProjectBadge={ui.grouping === 'person'}
            openWorkItem={ui.openWorkItem}
          />
        ))
      )}
    </div>
  );
}

function teamFor(ui: BoardUi, teamId: string): BoardTeamView | null {
  return ui.teams.find((team) => team.teamId === teamId) ?? null;
}

function writable(ui: BoardUi, card: BoardCard): boolean {
  return teamFor(ui, card.teamId)?.writable === true;
}

export const BoardCell = memo(BoardCellImpl);
