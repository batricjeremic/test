/**
 * Work item -> `BoardCard`.
 *
 * Spec: "Domain model and column mapping" fixes the card shape field for
 * field. The owning team comes from the area path, the iteration is the
 * one this window resolved for that team, and the canonical column comes
 * from the mapping layer — never from a guess.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard, Descriptor, IdentityRef } from '@eg/shared';
import type { AdoIdentityRef, AdoWorkItem } from '../ado/types.js';
import {
  ADO_FIELDS,
  readIdentityField,
  readNumberField,
  readStringField,
  readTagsField,
} from '../ado/types.js';
import type { AreaPathIndex } from './area-paths.js';
import { resolveOwningTeamId } from './area-paths.js';
import type { MappingIndex, TeamBoardContext } from './mapping.js';
import { resolveCanonicalColumn } from './mapping.js';
import { compareStrings } from './sorting.js';

/**
 * Descriptor prefixes Azure DevOps uses for groups. A card assigned to
 * one of these is not a person: it belongs in the Unassigned lane, which
 * is pinned at the top and never hidden.
 */
export const GROUP_DESCRIPTOR_PREFIXES: readonly string[] = [
  'vssgp.',
  'aadgp.',
];

/** True for a group descriptor, false for a person. */
export function isGroupDescriptor(descriptor: string): boolean {
  const value = descriptor.toLowerCase();
  return GROUP_DESCRIPTOR_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** A card with no assignee, or one assigned to a group. */
export function isUnassignedCard(card: BoardCard): boolean {
  const assignee = card.assignedTo;
  return assignee === null || isGroupDescriptor(assignee.descriptor);
}

/** The descriptor a person lane and a capacity row key on, or null. */
export function personDescriptorOf(card: BoardCard): Descriptor | null {
  const assignee = card.assignedTo;
  if (assignee === null) return null;
  return isGroupDescriptor(assignee.descriptor) ? null : assignee.descriptor;
}

/** `System.AssignedTo` as the card carries it, or null when unusable. */
export function toIdentityRef(
  identity: AdoIdentityRef | null,
): IdentityRef | null {
  if (identity === null) return null;
  const descriptor = identity.descriptor ?? identity.id ?? null;
  if (descriptor === null || descriptor.length === 0) return null;
  return { descriptor, displayName: identity.displayName ?? '' };
}

export interface CardBuildOptions {
  readonly index: MappingIndex;
  /** Null skips area-path resolution and keeps the fetching team. */
  readonly areaPaths: AreaPathIndex | null;
  /** The team whose iteration returned this work item. */
  readonly team: TeamBoardContext;
  /** That team's iteration for this window. */
  readonly iterationId: string;
}

/**
 * A built card plus whether its team was actually resolved from the area
 * path. The same work item can come back from two teams' iterations, and
 * the owned one is the copy that wins.
 */
export interface CardCandidate {
  readonly card: BoardCard;
  readonly owned: boolean;
}

/**
 * Builds one card. Returns null when the work item cannot make a valid
 * card — an id of zero, for instance — because a half-built card is
 * worse than an absent one.
 */
export function buildBoardCard(
  workItem: AdoWorkItem,
  options: CardBuildOptions,
): CardCandidate | null {
  if (!Number.isInteger(workItem.id) || workItem.id <= 0) return null;

  const fields = workItem.fields;
  const areaPath = readStringField(fields, ADO_FIELDS.areaPath);
  const resolvedTeamId =
    options.areaPaths === null
      ? null
      : resolveOwningTeamId(
          options.areaPaths,
          options.team.projectId,
          areaPath,
        );
  const resolvedTeam =
    resolvedTeamId === null
      ? undefined
      : options.index.teams.get(resolvedTeamId)?.team;
  const team = resolvedTeam ?? options.team;
  const owned = resolvedTeam !== undefined;

  const sourceColumn = readStringField(fields, team.columnFieldName);
  const resolution = resolveCanonicalColumn(
    options.index,
    team.teamId,
    sourceColumn,
  );

  const card: BoardCard = {
    workItemId: workItem.id,
    project: team.projectId,
    teamId: team.teamId,
    iterationId: options.iterationId,
    title: readStringField(fields, ADO_FIELDS.title) ?? '',
    type: readStringField(fields, ADO_FIELDS.workItemType) ?? 'Unknown',
    assignedTo: toIdentityRef(readIdentityField(fields, ADO_FIELDS.assignedTo)),
    state: readStringField(fields, ADO_FIELDS.state) ?? '',
    sourceColumn: sourceColumn ?? '',
    canonicalColumnId:
      resolution.kind === 'mapped'
        ? resolution.canonicalColumnId
        : UNMAPPED_COLUMN_ID,
    remainingWork: readNumberField(fields, ADO_FIELDS.remainingWork),
    tags: readTagsField(fields),
    rev: Number.isInteger(workItem.rev) && workItem.rev >= 0 ? workItem.rev : 0,
  };

  return { card, owned };
}

/**
 * One card per work item. A work item returned by two teams' iterations
 * keeps the copy whose team owns its area path; failing that, the lowest
 * team id, so the choice never depends on fan-out order.
 */
export function dedupeCardCandidates(
  candidates: readonly CardCandidate[],
): BoardCard[] {
  const byId = new Map<number, CardCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.card.workItemId);
    if (existing === undefined) {
      byId.set(candidate.card.workItemId, candidate);
      continue;
    }
    if (candidate.owned && !existing.owned) {
      byId.set(candidate.card.workItemId, candidate);
      continue;
    }
    if (candidate.owned === existing.owned) {
      const byTeam = compareStrings(
        candidate.card.teamId,
        existing.card.teamId,
      );
      const byIteration = compareStrings(
        candidate.card.iterationId,
        existing.card.iterationId,
      );
      if (byTeam < 0 || (byTeam === 0 && byIteration < 0)) {
        byId.set(candidate.card.workItemId, candidate);
      }
    }
  }
  return [...byId.values()].map((candidate) => candidate.card);
}

/**
 * Board order: canonical column, then project, then team, then work item
 * id. Unmapped cards sort after every mapped column so the Unmapped lane
 * reads last. Work item ids are unique, so the order is total.
 */
export function sortBoardCards(
  cards: readonly BoardCard[],
  index: MappingIndex,
): BoardCard[] {
  const order = new Map<string, number>(
    index.columns.map((column, position) => [column.id, position]),
  );
  const rank = (card: BoardCard): number =>
    order.get(card.canonicalColumnId) ?? Number.MAX_SAFE_INTEGER;
  return [...cards].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      compareStrings(a.project, b.project) ||
      compareStrings(a.teamId, b.teamId) ||
      a.workItemId - b.workItemId,
  );
}

/** Remaining work as hours, with absent and nonsense values read as none. */
export function remainingWorkHours(card: BoardCard): number | null {
  const value = card.remainingWork;
  if (value === null || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}
