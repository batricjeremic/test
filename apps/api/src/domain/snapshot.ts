/**
 * Snapshot aggregation: many team boards, one board.
 *
 * Spec: "Request flow for a board load" step 3 — the BFF fans out, builds
 * the snapshot and returns it. This is the pure half of that: raw
 * Azure DevOps shapes and configuration rows in, one `BoardSnapshot` out,
 * with no I/O anywhere near it.
 *
 * Order is deterministic throughout. The same input always produces the
 * same snapshot, because a board that reshuffles on every refresh is
 * unusable however correct its contents are.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardDefinition,
  BoardPermissions,
  BoardSnapshot,
  BoardSnapshotQuery,
  BoardTeamView,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
  RealtimeStatus,
  SnapshotCacheInfo,
} from '@eg/shared';
import type {
  AdoTeamMemberCapacity,
  AdoTeamSettingsDaysOff,
  AdoTeamSettingsIteration,
  AdoWorkItem,
} from '../ado/types.js';
import type { Clock } from '../ports.js';
import type { AreaPathIndex, TeamAreaPaths } from './area-paths.js';
import { buildAreaPathIndex } from './area-paths.js';
import type { CardCandidate } from './cards.js';
import {
  buildBoardCard,
  dedupeCardCandidates,
  sortBoardCards,
} from './cards.js';
import type { PersonTeamMembership, TeamCapacityInput } from './capacity.js';
import { computePersonLoads } from './capacity.js';
import { applyBoardFilters } from './filters.js';
import type { TeamIterationScope } from './iteration.js';
import {
  resolveBurndownAvailability,
  resolveTeamIterationScopes,
} from './iteration.js';
import type { MappingIndex, TeamBoardContext } from './mapping.js';
import {
  buildMappingIndex,
  collectUnmappedColumns,
  mappedCanonicalColumnIdsFor,
} from './mapping.js';
import { compareStrings } from './sorting.js';
import {
  buildSwimlanes,
  hiddenDescriptors,
  partitionHiddenCards,
} from './swimlanes.js';
import type { Weekday } from './working-days.js';

/** Work items as one iteration's `.../iterations/{id}/workitems` returned. */
export interface IterationWorkItems {
  readonly iterationId: string;
  readonly workItems: readonly AdoWorkItem[];
}

/** Capacity and days off are per team AND per iteration, never per team. */
export interface IterationCapacity {
  readonly iterationId: string;
  readonly capacities: readonly AdoTeamMemberCapacity[];
  readonly teamDaysOff: AdoTeamSettingsDaysOff | null;
}

/** Everything one team board contributes to the snapshot. */
export interface TeamSnapshotInput {
  readonly team: TeamBoardContext;
  /** The team's area paths, for resolving a card's owning team. */
  readonly areaPaths?: TeamAreaPaths;
  readonly iterations: readonly AdoTeamSettingsIteration[];
  /** The team's own working days. Defaults to Monday–Friday. */
  readonly workingDays?: readonly Weekday[];
  readonly workItems: readonly IterationWorkItems[];
  readonly capacity?: readonly IterationCapacity[];
}

export interface BoardSnapshotInput {
  readonly definition: BoardDefinition;
  readonly query: BoardSnapshotQuery;
  readonly canonicalColumns: readonly CanonicalColumn[];
  readonly mappings: readonly ColumnMapping[];
  readonly overrides?: readonly PersonOverride[];
  readonly teams: readonly TeamSnapshotInput[];
  readonly memberships?: readonly PersonTeamMembership[];
  readonly permissions: BoardPermissions;
  readonly cache: SnapshotCacheInfo;
  readonly realtime: RealtimeStatus;
  readonly traceId: string;
  readonly clock: Clock;
  /**
   * Security trimming, injected so this stays pure. A card the predicate
   * rejects is removed from the snapshot and counted, never returned.
   */
  readonly isCardVisible?: (card: BoardCard) => boolean;
}

/** The parts a caller may want without paying for the whole snapshot. */
export interface BoardSnapshotParts {
  readonly index: MappingIndex;
  readonly areaPaths: AreaPathIndex;
  readonly scopes: readonly TeamIterationScope[];
  /** Cards that survived filters, hiding and trimming, in board order. */
  readonly cards: readonly BoardCard[];
  readonly trimmedCards: readonly BoardCard[];
  readonly hiddenByOverride: readonly BoardCard[];
}

function teamViews(
  scopes: readonly TeamIterationScope[],
  index: MappingIndex,
  permissions: BoardPermissions,
): BoardTeamView[] {
  const writable = new Set(permissions.writableProjectIds);
  const views: BoardTeamView[] = [];
  for (const scope of scopes) {
    const primary = scope.primary;
    if (primary === null) continue;
    views.push({
      projectId: scope.team.projectId,
      teamId: scope.team.teamId,
      backlogLevel: scope.team.backlogLevel,
      iteration: primary.window,
      mappedCanonicalColumnIds: [
        ...mappedCanonicalColumnIdsFor(index, scope.team.teamId),
      ],
      writable: writable.has(scope.team.projectId),
    });
  }
  return views.sort(
    (a, b) =>
      compareStrings(a.projectId, b.projectId) ||
      compareStrings(a.teamId, b.teamId),
  );
}

/**
 * Builds the cards, lanes and loads without wrapping them in a snapshot.
 * `assembleBoardSnapshot` is this plus the envelope; tests and the write
 * path use this when only the parts matter.
 */
export function buildSnapshotParts(
  input: BoardSnapshotInput,
): BoardSnapshotParts {
  const teamContexts = input.teams.map((entry) => entry.team);
  const index = buildMappingIndex({
    boardId: input.definition.id,
    canonicalColumns: input.canonicalColumns,
    mappings: input.mappings,
    teams: teamContexts,
  });

  const areaPaths = buildAreaPathIndex(
    input.teams.flatMap((entry) =>
      entry.areaPaths === undefined ? [] : [entry.areaPaths],
    ),
  );

  const scopes = resolveTeamIterationScopes(
    input.teams.map((entry) => ({
      team: entry.team,
      iterations: entry.iterations,
      ...(entry.workingDays === undefined
        ? {}
        : { workingDays: entry.workingDays }),
    })),
    input.query.alignment,
    input.clock,
  );

  const candidates: CardCandidate[] = [];
  input.teams.forEach((entry, position) => {
    const scope = scopes[position];
    if (scope === undefined) return;
    const inScope = new Set(
      scope.iterations.map((iteration) => iteration.window.iterationId),
    );
    for (const batch of entry.workItems) {
      if (!inScope.has(batch.iterationId)) continue;
      for (const workItem of batch.workItems) {
        const candidate = buildBoardCard(workItem, {
          index,
          areaPaths,
          team: entry.team,
          iterationId: batch.iterationId,
        });
        if (candidate !== null) candidates.push(candidate);
      }
    }
  });

  const deduped = dedupeCardCandidates(candidates);
  const filtered = applyBoardFilters(deduped, input.query.filters);
  const { visible: afterOverrides, hidden: hiddenByOverride } =
    partitionHiddenCards(filtered, hiddenDescriptors(input.overrides ?? []));

  const isVisible = input.isCardVisible;
  const cards: BoardCard[] = [];
  const trimmedCards: BoardCard[] = [];
  for (const card of afterOverrides) {
    if (isVisible === undefined || isVisible(card)) cards.push(card);
    else trimmedCards.push(card);
  }

  return {
    index,
    areaPaths,
    scopes,
    cards: sortBoardCards(cards, index),
    trimmedCards: sortBoardCards(trimmedCards, index),
    hiddenByOverride,
  };
}

/**
 * One board load. Cards are resolved, filtered, trimmed, grouped and
 * counted; capacity is rolled up per person across their teams; unmapped
 * columns are surfaced rather than guessed; and burndown says plainly
 * whether it can be trusted.
 */
export function assembleBoardSnapshot(
  input: BoardSnapshotInput,
): BoardSnapshot {
  const parts = buildSnapshotParts(input);
  const grouping = input.query.grouping ?? input.definition.defaultGrouping;

  const capacityInputs: TeamCapacityInput[] = [];
  input.teams.forEach((entry, position) => {
    const scope = parts.scopes[position];
    if (scope === undefined) return;
    for (const iteration of scope.iterations) {
      const record = entry.capacity?.find(
        (candidate) => candidate.iterationId === iteration.window.iterationId,
      );
      capacityInputs.push({
        team: entry.team,
        iteration,
        capacities: record?.capacities ?? [],
        teamDaysOff: record?.teamDaysOff ?? null,
      });
    }
  });

  const swimlanes = buildSwimlanes({
    grouping,
    cards: parts.cards,
    trimmedCards: parts.trimmedCards,
    teams: input.teams.map((entry) => entry.team),
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
  });

  const personLoad = computePersonLoads({
    teams: capacityInputs,
    cards: parts.cards,
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
    ...(input.memberships === undefined
      ? {}
      : { memberships: input.memberships }),
    clock: input.clock,
  });

  return {
    boardId: input.definition.id,
    boardName: input.definition.name,
    orgId: input.definition.orgId,
    generatedAt: input.clock.now().toISOString(),
    traceId: input.traceId,
    cache: input.cache,
    grouping,
    alignment: input.query.alignment,
    filters: input.query.filters,
    columns: [...parts.index.columns],
    teams: teamViews(parts.scopes, parts.index, input.permissions),
    swimlanes,
    cards: [...parts.cards],
    personLoad,
    unmappedColumns: collectUnmappedColumns(parts.cards, parts.index),
    permissions: input.permissions,
    realtime: input.realtime,
    burndown: resolveBurndownAvailability(parts.scopes),
    hiddenCardCount: parts.trimmedCards.length + parts.hiddenByOverride.length,
  };
}

/** How many cards sit in the Unmapped lane, for the admin screen's badge. */
export function unmappedCardCount(cards: readonly BoardCard[]): number {
  return cards.filter((card) => card.canonicalColumnId === UNMAPPED_COLUMN_ID)
    .length;
}
