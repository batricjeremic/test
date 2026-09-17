/**
 * Read-side helpers shared by the board and the capacity view, so both
 * put a card in the same lane.
 */
import { UNASSIGNED_LANE_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardGrouping,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
} from '@eg/shared';

/**
 * Which lane a card belongs to. A card assigned to a group or to nobody
 * goes to the unassigned lane, which is pinned at the top and never
 * hidden.
 */
export function swimlaneIdForCard(
  card: BoardCard,
  grouping: BoardGrouping,
  swimlanes: readonly BoardSwimlane[],
): string {
  if (grouping === 'team') {
    const lane = swimlanes.find(
      (candidate) =>
        candidate.kind === 'team' && candidate.teamId === card.teamId,
    );
    return lane?.id ?? UNASSIGNED_LANE_ID;
  }
  const descriptor = card.assignedTo?.descriptor;
  if (descriptor === undefined) return UNASSIGNED_LANE_ID;
  const lane = swimlanes.find(
    (candidate) =>
      candidate.kind === 'person' && candidate.personDescriptor === descriptor,
  );
  return lane?.id ?? UNASSIGNED_LANE_ID;
}

/** Lane id to its cards, in snapshot order. Every lane gets an entry. */
export function groupCardsBySwimlane(
  cards: readonly BoardCard[],
  swimlanes: readonly BoardSwimlane[],
  grouping: BoardGrouping,
): Map<string, BoardCard[]> {
  const byLane = new Map<string, BoardCard[]>();
  for (const lane of swimlanes) byLane.set(lane.id, []);
  for (const card of cards) {
    const laneId = swimlaneIdForCard(card, grouping, swimlanes);
    const bucket = byLane.get(laneId);
    if (bucket) bucket.push(card);
    else byLane.set(laneId, [card]);
  }
  return byLane;
}

/** Column id to its cards. Every canonical column gets an entry. */
export function groupCardsByColumn(
  cards: readonly BoardCard[],
  columns: readonly CanonicalColumn[],
): Map<string, BoardCard[]> {
  const byColumn = new Map<string, BoardCard[]>();
  for (const column of columns) byColumn.set(column.id, []);
  for (const card of cards) {
    const bucket = byColumn.get(card.canonicalColumnId);
    if (bucket) bucket.push(card);
    else byColumn.set(card.canonicalColumnId, [card]);
  }
  return byColumn;
}

/** Lane id to column id to cards: everything the grid needs, once. */
export function buildBoardMatrix(
  cards: readonly BoardCard[],
  swimlanes: readonly BoardSwimlane[],
  columns: readonly CanonicalColumn[],
  grouping: BoardGrouping,
): Map<string, Map<string, BoardCard[]>> {
  const byLane = groupCardsBySwimlane(cards, swimlanes, grouping);
  const matrix = new Map<string, Map<string, BoardCard[]>>();
  for (const [laneId, laneCards] of byLane) {
    matrix.set(laneId, groupCardsByColumn(laneCards, columns));
  }
  return matrix;
}

/** The team view a card belongs to, for writability and mapped columns. */
export function teamViewForCard(
  card: BoardCard,
  teams: readonly BoardTeamView[],
): BoardTeamView | null {
  return teams.find((team) => team.teamId === card.teamId) ?? null;
}
