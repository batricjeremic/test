/**
 * Pure draft transforms for the admin screen.
 *
 * Nothing here touches React or the network, so the mapping rules can be
 * reasoned about — and tested — on their own.
 */
import type {
  BoardSnapshot,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  UnmappedColumnRef,
} from '@eg/shared';
import type { AdminTeam, TeamColumnRef } from './types';

/** Stable sort by `order`, then by name, so render order is deterministic. */
export function sortColumns(
  columns: readonly CanonicalColumn[],
): CanonicalColumn[] {
  return [...columns].sort(
    (left, right) =>
      left.order - right.order || left.name.localeCompare(right.name),
  );
}

/** Renumbers `order` to 0..n-1 in array order. Applied before every save. */
export function renumberColumns(
  columns: readonly CanonicalColumn[],
): CanonicalColumn[] {
  return columns.map((column, index) =>
    column.order === index ? column : { ...column, order: index },
  );
}

/** Moves one column by `delta` places. Out-of-range moves are no-ops. */
export function moveColumn(
  columns: readonly CanonicalColumn[],
  columnId: string,
  delta: number,
): CanonicalColumn[] {
  const ordered = sortColumns(columns);
  const from = ordered.findIndex((column) => column.id === columnId);
  if (from < 0) return ordered;
  const to = from + delta;
  if (to < 0 || to >= ordered.length) return ordered;
  const moved = ordered[from];
  if (!moved) return ordered;
  const next = [...ordered];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberColumns(next);
}

/** Moves the dragged column to the position of the column it was dropped on. */
export function reorderColumns(
  columns: readonly CanonicalColumn[],
  activeId: string,
  overId: string,
): CanonicalColumn[] {
  const ordered = sortColumns(columns);
  const from = ordered.findIndex((column) => column.id === activeId);
  const to = ordered.findIndex((column) => column.id === overId);
  if (from < 0 || to < 0 || from === to) return ordered;
  return moveColumn(ordered, activeId, to - from);
}

/** `In review` → `col-in-review`, uniquified against the ids in use. */
export function newColumnId(
  name: string,
  existing: readonly CanonicalColumn[],
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'column';
  const taken = new Set(existing.map((column) => column.id));
  let candidate = `col-${slug}`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `col-${slug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** The mapping row for one team column, or null when it is unmapped. */
export function findMapping(
  mappings: readonly ColumnMapping[],
  teamId: string,
  sourceColumnId: string,
): ColumnMapping | null {
  return (
    mappings.find(
      (mapping) =>
        mapping.teamId === teamId && mapping.sourceColumnId === sourceColumnId,
    ) ?? null
  );
}

/**
 * Points one team column at a canonical column, or removes the row when
 * `canonicalColumnId` is null. Removing is how a column becomes unmapped
 * again, which is deliberately possible: a wrong mapping is worse than
 * none, because a wrong one silently misplaces cards.
 */
export function setMapping(
  mappings: readonly ColumnMapping[],
  boardId: string,
  teamId: string,
  sourceColumnId: string,
  canonicalColumnId: string | null,
): ColumnMapping[] {
  const rest = mappings.filter(
    (mapping) =>
      mapping.teamId !== teamId || mapping.sourceColumnId !== sourceColumnId,
  );
  if (canonicalColumnId === null) return rest;
  const existing = findMapping(mappings, teamId, sourceColumnId);
  return [
    ...rest,
    {
      boardId,
      teamId,
      sourceColumnId,
      canonicalColumnId,
      targetState: existing?.targetState ?? null,
    },
  ];
}

/**
 * Sets the optional `targetState` on an existing mapping row. An empty
 * string means "no state write": the board column moves alone. The value
 * is stored as typed — it is trimmed once, on the way to the BFF, so a
 * space in the middle of a state name survives being typed.
 */
export function setTargetState(
  mappings: readonly ColumnMapping[],
  teamId: string,
  sourceColumnId: string,
  targetState: string,
): ColumnMapping[] {
  return mappings.map((mapping) =>
    mapping.teamId === teamId && mapping.sourceColumnId === sourceColumnId
      ? {
          ...mapping,
          targetState: targetState.trim() === '' ? null : targetState,
        }
      : mapping,
  );
}

/** Mapping rows for teams that are no longer a source of this board. */
export function pruneMappings(
  mappings: readonly ColumnMapping[],
  sources: readonly BoardSource[],
  columns: readonly CanonicalColumn[],
): ColumnMapping[] {
  const teamIds = new Set(sources.map((source) => source.teamId));
  const columnIds = new Set(columns.map((column) => column.id));
  return mappings.filter(
    (mapping) =>
      teamIds.has(mapping.teamId) && columnIds.has(mapping.canonicalColumnId),
  );
}

type TeamNaming = {
  readonly teamName: string;
  readonly projectName: string;
};

/**
 * Builds the matrix rows: one entry per source team, each carrying every
 * column of that team we know about.
 */
export function buildAdminTeams(
  sources: readonly BoardSource[],
  mappings: readonly ColumnMapping[],
  unmapped: readonly UnmappedColumnRef[],
  naming: ReadonlyMap<string, TeamNaming>,
  extraColumns: readonly TeamColumnRef[] = [],
): AdminTeam[] {
  const byTeam = new Map<string, AdminTeam>();

  for (const source of sources) {
    const known = byTeam.get(source.teamId);
    if (known) {
      byTeam.set(source.teamId, {
        ...known,
        backlogLevels: known.backlogLevels.includes(source.backlogLevel)
          ? known.backlogLevels
          : [...known.backlogLevels, source.backlogLevel],
      });
      continue;
    }
    const named = naming.get(source.teamId);
    byTeam.set(source.teamId, {
      teamId: source.teamId,
      projectId: source.projectId,
      teamName: named?.teamName ?? source.teamId,
      projectName: named?.projectName ?? source.projectId,
      backlogLevels: [source.backlogLevel],
      columns: [],
    });
  }

  const cardCounts = new Map<string, number>();
  for (const ref of unmapped) {
    cardCounts.set(`${ref.teamId}::${ref.sourceColumn}`, ref.cardCount);
  }

  const addColumn = (teamId: string, sourceColumnId: string): void => {
    const team = byTeam.get(teamId);
    if (!team) return;
    if (team.columns.some((column) => column.sourceColumnId === sourceColumnId))
      return;
    byTeam.set(teamId, {
      ...team,
      columns: [
        ...team.columns,
        {
          teamId,
          projectId: team.projectId,
          teamName: team.teamName,
          projectName: team.projectName,
          sourceColumnId,
          cardCount: cardCounts.get(`${teamId}::${sourceColumnId}`) ?? 0,
        },
      ],
    });
  };

  for (const mapping of mappings)
    addColumn(mapping.teamId, mapping.sourceColumnId);
  for (const ref of unmapped) addColumn(ref.teamId, ref.sourceColumn);
  for (const extra of extraColumns)
    addColumn(extra.teamId, extra.sourceColumnId);

  return [...byTeam.values()]
    .map((team) => ({
      ...team,
      columns: [...team.columns].sort((left, right) =>
        left.sourceColumnId.localeCompare(right.sourceColumnId),
      ),
    }))
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName) ||
        left.teamName.localeCompare(right.teamName),
    );
}

/**
 * Every team column with no mapping row. This is the number the screen
 * exists to drive to zero: cards in these columns land in the Unmapped
 * lane instead of being placed.
 */
export function unmappedTeamColumns(
  teams: readonly AdminTeam[],
  mappings: readonly ColumnMapping[],
): TeamColumnRef[] {
  const result: TeamColumnRef[] = [];
  for (const team of teams) {
    for (const column of team.columns) {
      if (findMapping(mappings, team.teamId, column.sourceColumnId) === null) {
        result.push(column);
      }
    }
  }
  return result;
}

/** Team and project display names, taken from the snapshot's team views. */
export function namingFromSnapshot(
  snapshot: BoardSnapshot | null,
): Map<string, TeamNaming> {
  const naming = new Map<string, TeamNaming>();
  if (!snapshot) return naming;
  for (const team of snapshot.teams) {
    naming.set(team.teamId, {
      teamName: team.iteration.teamName,
      projectName: team.iteration.projectName,
    });
  }
  for (const ref of snapshot.unmappedColumns) {
    if (!naming.has(ref.teamId)) {
      naming.set(ref.teamId, {
        teamName: ref.teamName,
        projectName: ref.projectId,
      });
    }
  }
  return naming;
}
