/**
 * Drag payload helpers.
 *
 * `@dnd-kit` hands `data` back as `unknown`, so these guards are the only
 * honest way to read it. `evaluateDrop` holds the spec's rule that a drop
 * onto a column the card's team has no mapping for is refused at drag
 * start rather than failing at the BFF.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard, BoardTeamView } from '@eg/shared';
import type { CardDragData, ColumnDropData, DropDecision } from '../types';

export function isCardDragData(value: unknown): value is CardDragData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CardDragData>;
  return (
    candidate.kind === 'card' &&
    typeof candidate.workItemId === 'number' &&
    typeof candidate.fromCanonicalColumnId === 'string' &&
    Array.isArray(candidate.allowedCanonicalColumnIds)
  );
}

export function isColumnDropData(value: unknown): value is ColumnDropData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ColumnDropData>;
  return (
    candidate.kind === 'column' &&
    typeof candidate.canonicalColumnId === 'string' &&
    typeof candidate.swimlaneId === 'string'
  );
}

/** Builds the payload for `useDraggable({ id, data })`. */
export function buildCardDragData(
  card: BoardCard,
  team: BoardTeamView | null,
  swimlaneId: string,
): CardDragData {
  return {
    kind: 'card',
    workItemId: card.workItemId,
    rev: card.rev,
    projectId: team?.projectId ?? card.project,
    teamId: card.teamId,
    swimlaneId,
    fromCanonicalColumnId: card.canonicalColumnId,
    allowedCanonicalColumnIds: team?.mappedCanonicalColumnIds ?? [],
    writable: team?.writable ?? false,
  };
}

/**
 * May this card be dropped here? A locked card (its move is in flight)
 * and a read-only project are refused, as is a column this card's team
 * has no mapping row for.
 */
export function evaluateDrop(
  drag: CardDragData,
  drop: ColumnDropData,
  state: { locked?: boolean } = {},
): DropDecision {
  if (state.locked === true) {
    return { allowed: false, reason: 'card-locked' };
  }
  if (!drag.writable) {
    return { allowed: false, reason: 'not-writable' };
  }
  if (drop.canonicalColumnId === UNMAPPED_COLUMN_ID) {
    return { allowed: false, reason: 'unmapped-lane' };
  }
  if (
    drag.fromCanonicalColumnId === drop.canonicalColumnId &&
    drag.swimlaneId === drop.swimlaneId
  ) {
    return { allowed: false, reason: 'same-column' };
  }
  if (!drag.allowedCanonicalColumnIds.includes(drop.canonicalColumnId)) {
    return { allowed: false, reason: 'mapping-missing' };
  }
  return { allowed: true };
}
