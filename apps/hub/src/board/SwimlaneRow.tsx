/**
 * One swimlane: a sticky row header plus one cell per canonical column.
 *
 * The header carries the numbers a lead actually asks for — cards, hours
 * remaining, how many carry no estimate, how many the caller may not see
 * — and, when teams run their own cadences, that team's sprint dates, so
 * "day 2 of 15" next to "day 8 of 10" is visible rather than implied.
 *
 * A person lane also carries that person's one capacity bar, rolled up
 * across every team they are on. That bar is the reason the product
 * exists, so it belongs on the lane itself rather than only in a panel.
 */
import { memo } from 'react';
import type { BoardCard, BoardSwimlane, CanonicalColumn } from '@eg/shared';
import { PersonCapacity } from '../capacity';
import { BoardCell } from './BoardCell';
import type { BoardUi } from './boardUi';
import { formatIterationLine, formatLaneTotals } from './format';
import {
  isUnassignedLane,
  iterationWindowsForLane,
  laneIsReadOnly,
} from './layout';

export type SwimlaneRowProps = {
  ui: BoardUi;
  lane: BoardSwimlane;
  columns: readonly CanonicalColumn[];
  /** Column id to the lane's cards in that column. */
  cardsByColumn: ReadonlyMap<string, BoardCard[]>;
};

const NO_CARDS: readonly BoardCard[] = [];

function SwimlaneRowImpl({
  ui,
  lane,
  columns,
  cardsByColumn,
}: SwimlaneRowProps): JSX.Element {
  const collapsed = ui.collapsedLaneIds.includes(lane.id);
  const pinned = isUnassignedLane(lane);
  const laneCards = columns.flatMap(
    (column) => cardsByColumn.get(column.id) ?? [],
  );
  const readOnly = laneIsReadOnly(laneCards, ui.teams);
  const personLoad =
    lane.personDescriptor === null
      ? null
      : (ui.personLoadByDescriptor.get(lane.personDescriptor) ?? null);
  const windows = ui.mixedCadence
    ? iterationWindowsForLane(lane, laneCards, ui.teams)
    : [];

  return (
    <div className="eg-board__row" role="row">
      <div
        role="rowheader"
        className="eg-board__lane-header"
        data-lane-id={lane.id}
        data-pinned={pinned ? 'true' : 'false'}
        data-readonly={readOnly ? 'true' : 'false'}
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <div className="eg-lane">
          <div className="eg-lane__top">
            <button
              type="button"
              className="eg-collapse"
              aria-expanded={!collapsed}
              onClick={() => ui.toggleLane(lane.id)}
            >
              <span className="eg-collapse__chevron" aria-hidden="true">
                ▾
              </span>
              <span className="eg-visually-hidden">
                {collapsed ? 'Expand' : 'Collapse'} {lane.label}
              </span>
            </button>
            <span className="eg-lane__title">{lane.label}</span>
            {pinned ? <span className="eg-badge">Pinned</span> : null}
            {readOnly ? <span className="eg-badge">Read only</span> : null}
          </div>
          <div className="eg-lane__meta">{formatLaneTotals(lane)}</div>
          {collapsed || personLoad === null ? null : (
            <PersonCapacity
              person={personLoad}
              variant="lane"
              showName={false}
            />
          )}
          {!collapsed && lane.hiddenCardCount > 0 ? (
            <div className="eg-lane__meta">
              {lane.hiddenCardCount} card
              {lane.hiddenCardCount === 1 ? '' : 's'} hidden by permissions
            </div>
          ) : null}
          {!collapsed && windows.length > 0 ? (
            <div className="eg-lane__sprints">
              {windows.map((window) => (
                <span key={window.teamId}>{formatIterationLine(window)}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {columns.map((column) => (
        <BoardCell
          key={column.id}
          ui={ui}
          lane={lane}
          column={column}
          cards={cardsByColumn.get(column.id) ?? NO_CARDS}
          collapsed={collapsed}
        />
      ))}
    </div>
  );
}

export const SwimlaneRow = memo(SwimlaneRowImpl);
