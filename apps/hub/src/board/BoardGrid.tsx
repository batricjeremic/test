/**
 * The grid itself: canonical columns across the top in their configured
 * order with a card count each, swimlanes down the side with the
 * unassigned lane pinned first.
 *
 * It is a real `role="grid"` — lane headers are row headers, cells are
 * grid cells — because a board only usable with a mouse fails half the
 * audience.
 */
import { memo } from 'react';
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard, BoardSwimlane, CanonicalColumn } from '@eg/shared';
import type { CSSProperties } from 'react';
import { SwimlaneRow } from './SwimlaneRow';
import type { BoardUi } from './boardUi';

export type BoardGridProps = {
  ui: BoardUi;
  columns: readonly CanonicalColumn[];
  lanes: readonly BoardSwimlane[];
  /** Lane id to column id to cards, built once per snapshot. */
  matrix: ReadonlyMap<string, Map<string, BoardCard[]>>;
  cardCounts: ReadonlyMap<string, number>;
  label: string;
};

const NO_CELLS: ReadonlyMap<string, BoardCard[]> = new Map();

function BoardGridImpl({
  ui,
  columns,
  lanes,
  matrix,
  cardCounts,
  label,
}: BoardGridProps): JSX.Element {
  const style = {
    '--eg-column-count': columns.length,
  } as CSSProperties;

  return (
    <div
      className="eg-board"
      role="grid"
      aria-label={label}
      aria-rowcount={lanes.length + 1}
      aria-colcount={columns.length + 1}
      style={style}
    >
      <div className="eg-board__row" role="row">
        <div role="columnheader" className="eg-board__column-header">
          {ui.grouping === 'team' ? 'Team' : 'Person'}
        </div>
        {columns.map((column) => (
          <div
            key={column.id}
            role="columnheader"
            className="eg-board__column-header"
            data-column-id={column.id}
            data-unmapped={column.id === UNMAPPED_COLUMN_ID ? 'true' : 'false'}
          >
            <span className="eg-column-head">
              <span className="eg-column-head__name">{column.name}</span>
              <span className="eg-count">{cardCounts.get(column.id) ?? 0}</span>
            </span>
          </div>
        ))}
      </div>

      {lanes.map((lane) => (
        <SwimlaneRow
          key={lane.id}
          ui={ui}
          lane={lane}
          columns={columns}
          cardsByColumn={matrix.get(lane.id) ?? NO_CELLS}
        />
      ))}
    </div>
  );
}

export const BoardGrid = memo(BoardGridImpl);
