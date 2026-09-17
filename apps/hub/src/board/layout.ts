/**
 * Pure shaping helpers for the board grid.
 *
 * Everything here is a plain function over the shared DTOs so the grid
 * can be memoised on the snapshot and never recompute during a drag.
 */
import { UNASSIGNED_LANE_ID, UNMAPPED_COLUMN_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
  IterationAlignment,
  TeamIterationWindow,
  UnmappedColumnRef,
} from '@eg/shared';

/** Label of the trailing column that holds cards with no mapping row. */
export const UNMAPPED_COLUMN_NAME = 'Unmapped';

/** Label of the lane cards with no assignee (or a group) fall into. */
export const UNASSIGNED_LANE_LABEL = 'Unassigned';

/**
 * Canonical columns in configured order, with an "Unmapped" column
 * appended when anything landed there. The column is never a drop target
 * — `evaluateDrop` refuses it — it exists so a stranded card is visible
 * rather than silently misplaced.
 */
export function buildColumnList(
  boardId: string,
  columns: readonly CanonicalColumn[],
  cards: readonly BoardCard[],
  unmappedColumns: readonly UnmappedColumnRef[],
): CanonicalColumn[] {
  const ordered = [...columns].sort((a, b) => a.order - b.order);
  const hasUnmappedCard = cards.some(
    (card) => card.canonicalColumnId === UNMAPPED_COLUMN_ID,
  );
  if (!hasUnmappedCard && unmappedColumns.length === 0) return ordered;
  return [
    ...ordered,
    {
      id: UNMAPPED_COLUMN_ID,
      boardId,
      name: UNMAPPED_COLUMN_NAME,
      order: ordered.length,
      stateCategory: 'Proposed',
    },
  ];
}

/**
 * Lanes in render order. The unassigned lane is pinned at the top and is
 * added when cards fall into it but the snapshot carried no such lane, so
 * a card can never be dropped from the board entirely.
 */
export function orderSwimlanes(
  swimlanes: readonly BoardSwimlane[],
  cards: readonly BoardCard[],
  grouping: 'person' | 'team',
): BoardSwimlane[] {
  const lanes = [...swimlanes];
  if (needsUnassignedLane(lanes, cards, grouping)) {
    lanes.push(makeFallbackUnassignedLane(swimlanes, cards, grouping));
  }
  return lanes.sort(compareSwimlanes);
}

function compareSwimlanes(a: BoardSwimlane, b: BoardSwimlane): number {
  const pinned = Number(isUnassignedLane(b)) - Number(isUnassignedLane(a));
  if (pinned !== 0) return pinned;
  if (a.order !== b.order) return a.order - b.order;
  return a.label.localeCompare(b.label);
}

export function isUnassignedLane(lane: BoardSwimlane): boolean {
  return lane.kind === 'unassigned' || lane.id === UNASSIGNED_LANE_ID;
}

function needsUnassignedLane(
  lanes: readonly BoardSwimlane[],
  cards: readonly BoardCard[],
  grouping: 'person' | 'team',
): boolean {
  if (lanes.some(isUnassignedLane)) return false;
  return cards.some((card) => laneIsMissing(card, lanes, grouping));
}

function laneIsMissing(
  card: BoardCard,
  lanes: readonly BoardSwimlane[],
  grouping: 'person' | 'team',
): boolean {
  if (grouping === 'team') {
    return !lanes.some(
      (lane) => lane.kind === 'team' && lane.teamId === card.teamId,
    );
  }
  const descriptor = card.assignedTo?.descriptor;
  if (descriptor === undefined) return true;
  return !lanes.some(
    (lane) => lane.kind === 'person' && lane.personDescriptor === descriptor,
  );
}

function makeFallbackUnassignedLane(
  lanes: readonly BoardSwimlane[],
  cards: readonly BoardCard[],
  grouping: 'person' | 'team',
): BoardSwimlane {
  const stranded = cards.filter((card) => laneIsMissing(card, lanes, grouping));
  const hours = stranded.reduce(
    (total, card) => total + (card.remainingWork ?? 0),
    0,
  );
  return {
    id: UNASSIGNED_LANE_ID,
    kind: 'unassigned',
    label: UNASSIGNED_LANE_LABEL,
    personDescriptor: null,
    teamId: null,
    order: 0,
    cardCount: stranded.length,
    hiddenCardCount: 0,
    remainingWorkHours: hours,
    cardsWithoutRemainingWork: stranded.filter(
      (card) => card.remainingWork === null,
    ).length,
  };
}

/** The team a lane belongs to, when the lane is one team's. */
export function teamForLane(
  lane: BoardSwimlane,
  teams: readonly BoardTeamView[],
): BoardTeamView | null {
  if (lane.teamId === null) return null;
  return teams.find((team) => team.teamId === lane.teamId) ?? null;
}

/**
 * The sprint windows a lane spans. A team lane has one; a person lane has
 * one per team they carry cards on, because two teams can be in
 * differently dated sprints at the same moment.
 */
export function iterationWindowsForLane(
  lane: BoardSwimlane,
  laneCards: readonly BoardCard[],
  teams: readonly BoardTeamView[],
): TeamIterationWindow[] {
  const wanted = new Set<string>(
    lane.teamId === null ? laneCards.map((card) => card.teamId) : [lane.teamId],
  );
  return teams
    .filter((team) => wanted.has(team.teamId))
    .map((team) => team.iteration);
}

/**
 * A lane is dimmed when every team it draws from is read-only: the spec
 * wants the refusal visible before the user tries to drag.
 */
export function laneIsReadOnly(
  laneCards: readonly BoardCard[],
  teams: readonly BoardTeamView[],
): boolean {
  if (laneCards.length === 0) return false;
  return laneCards.every((card) => !isCardWritable(card, teams));
}

export function isCardWritable(
  card: BoardCard,
  teams: readonly BoardTeamView[],
): boolean {
  const team = teams.find((candidate) => candidate.teamId === card.teamId);
  return team?.writable === true;
}

/** Card counts per column, for the header. Includes every column. */
export function countCardsByColumn(
  cards: readonly BoardCard[],
  columns: readonly CanonicalColumn[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const column of columns) counts.set(column.id, 0);
  for (const card of cards) {
    const current = counts.get(card.canonicalColumnId) ?? 0;
    counts.set(card.canonicalColumnId, current + 1);
  }
  return counts;
}

/**
 * Whether per-lane sprint dates carry information. They do exactly when
 * every team runs its own current sprint, which is the mixed-cadence
 * mode the spec describes.
 */
export function showsMixedCadence(alignment: IterationAlignment): boolean {
  return alignment.mode === 'each-team-current';
}
