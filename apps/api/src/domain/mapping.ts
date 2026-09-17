/**
 * Column mapping resolution — the hard part, per the spec.
 *
 * Spec: "Domain model and column mapping". Each team board has its own
 * columns and the column a card sits in is the work item field
 * `WEF_<boardId>_Kanban.Column`. To render one board we resolve, per
 * team, board id then column set then the mapping row.
 *
 * Two directions:
 *  - forward, for reads: team column value -> canonical column, or the
 *    visible Unmapped lane. Never a guess, never a silent placement.
 *  - reverse, for writes: canonical column + team -> that team's source
 *    column and optional `targetState`, or a refusal the hub can act on
 *    before the drag even starts.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  MappingMissingFailure,
  UnmappedColumnRef,
} from '@eg/shared';
import type { AdoBoard, AdoBoardColumnType } from '../ado/types.js';
import {
  kanbanColumnDoneFieldName,
  kanbanColumnFieldName,
} from '../ado/types.js';
import { compareStrings } from './sorting.js';

/* ------------------------------------------------------------------ */
/* Team board context                                                  */
/* ------------------------------------------------------------------ */

/** One column on one team's board, reduced to what the mapping needs. */
export interface TeamBoardColumn {
  readonly id: string;
  readonly name: string;
  /** A split column has a Doing and a Done half. */
  readonly isSplit: boolean;
  readonly columnType: AdoBoardColumnType | null;
  /** Work item type -> state bound to this column, when one is bound. */
  readonly stateMappings: Readonly<Record<string, string>>;
  /** Position on the team's own board; drives deterministic tie-breaks. */
  readonly order: number;
}

/**
 * Everything about one team board that read and write resolution need.
 * `columnFieldName` comes from the board document when it carries one,
 * because that is authoritative, and is derived from the board id only
 * as a fallback.
 */
export interface TeamBoardContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly backlogLevel: string;
  /** The Azure DevOps board id, which is what the WEF field is named for. */
  readonly adoBoardId: string;
  readonly columnFieldName: string;
  readonly doneFieldName: string;
  readonly columns: readonly TeamBoardColumn[];
}

export interface TeamBoardContextInput {
  readonly source: BoardSource;
  readonly board: AdoBoard;
  readonly projectName?: string;
  readonly teamName?: string;
}

/** Reduces a raw board document to the context the domain works over. */
export function buildTeamBoardContext(
  input: TeamBoardContextInput,
): TeamBoardContext {
  const { source, board } = input;
  const columns: TeamBoardColumn[] = board.columns.map((column, order) => ({
    id: column.id,
    name: column.name,
    isSplit: column.isSplit === true,
    columnType: column.columnType ?? null,
    stateMappings: column.stateMappings ?? {},
    order,
  }));
  return {
    projectId: source.projectId,
    projectName: input.projectName ?? '',
    teamId: source.teamId,
    teamName: input.teamName ?? '',
    backlogLevel: source.backlogLevel,
    adoBoardId: board.id,
    columnFieldName:
      board.fields?.columnField.referenceName ??
      kanbanColumnFieldName(board.id),
    doneFieldName:
      board.fields?.doneField?.referenceName ??
      kanbanColumnDoneFieldName(board.id),
    columns,
  };
}

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

/** Column names are compared case- and whitespace-insensitively. */
export function normalizeColumnKey(value: string): string {
  return value.trim().toLowerCase();
}

export interface TeamColumnIndex {
  readonly team: TeamBoardContext;
  readonly columnsById: ReadonlyMap<string, TeamBoardColumn>;
  readonly columnsByName: ReadonlyMap<string, TeamBoardColumn>;
  readonly mappingBySourceColumnId: ReadonlyMap<string, ColumnMapping>;
  readonly mappingByCanonicalColumnId: ReadonlyMap<string, ColumnMapping>;
  /** Sorted by canonical order: what the hub allows as a drop target. */
  readonly mappedCanonicalColumnIds: readonly string[];
}

export interface MappingIndex {
  readonly boardId: string;
  /** Canonical columns, ascending by `order`. */
  readonly columns: readonly CanonicalColumn[];
  readonly columnsById: ReadonlyMap<string, CanonicalColumn>;
  readonly teams: ReadonlyMap<string, TeamColumnIndex>;
}

export interface MappingIndexInput {
  readonly boardId: string;
  readonly canonicalColumns: readonly CanonicalColumn[];
  readonly mappings: readonly ColumnMapping[];
  readonly teams: readonly TeamBoardContext[];
}

/**
 * Builds the lookup both directions run over. Mapping rows for another
 * board, for an unknown team, or pointing at a canonical column this
 * board does not declare are dropped: a row that cannot be honoured must
 * not put a card somewhere nobody chose.
 */
export function buildMappingIndex(input: MappingIndexInput): MappingIndex {
  const columns = [...input.canonicalColumns]
    .filter((column) => column.boardId === input.boardId)
    .sort((a, b) => a.order - b.order || compareStrings(a.id, b.id));
  const columnsById = new Map(columns.map((column) => [column.id, column]));

  const teams = new Map<string, TeamColumnIndex>();
  for (const team of input.teams) {
    const columnsById2 = new Map<string, TeamBoardColumn>();
    const columnsByName = new Map<string, TeamBoardColumn>();
    for (const column of team.columns) {
      columnsById2.set(column.id, column);
      const key = normalizeColumnKey(column.name);
      if (!columnsByName.has(key)) columnsByName.set(key, column);
    }

    const rows = input.mappings.filter(
      (mapping) =>
        mapping.boardId === input.boardId &&
        mapping.teamId === team.teamId &&
        columnsById.has(mapping.canonicalColumnId),
    );

    const mappingBySourceColumnId = new Map<string, ColumnMapping>();
    for (const row of rows) {
      const column =
        columnsById2.get(row.sourceColumnId) ??
        columnsByName.get(normalizeColumnKey(row.sourceColumnId));
      // Keyed on the team's own column id, so a row written against the
      // column name still resolves.
      const key = column?.id ?? row.sourceColumnId;
      if (!mappingBySourceColumnId.has(key)) {
        mappingBySourceColumnId.set(key, row);
      }
    }

    const mappingByCanonicalColumnId = new Map<string, ColumnMapping>();
    const ordered = [...mappingBySourceColumnId.entries()].sort(
      ([leftId], [rightId]) => {
        const left = columnsById2.get(leftId);
        const right = columnsById2.get(rightId);
        return (
          (left?.order ?? Number.MAX_SAFE_INTEGER) -
            (right?.order ?? Number.MAX_SAFE_INTEGER) ||
          compareStrings(leftId, rightId)
        );
      },
    );
    for (const [, row] of ordered) {
      // Two source columns may map onto one canonical column. The write
      // path picks the first in the team's own board order, always.
      if (!mappingByCanonicalColumnId.has(row.canonicalColumnId)) {
        mappingByCanonicalColumnId.set(row.canonicalColumnId, row);
      }
    }

    const mappedCanonicalColumnIds = columns
      .filter((column) => mappingByCanonicalColumnId.has(column.id))
      .map((column) => column.id);

    teams.set(team.teamId, {
      team,
      columnsById: columnsById2,
      columnsByName,
      mappingBySourceColumnId,
      mappingByCanonicalColumnId,
      mappedCanonicalColumnIds,
    });
  }

  return { boardId: input.boardId, columns, columnsById, teams };
}

/* ------------------------------------------------------------------ */
/* Forward: team column value -> canonical column                      */
/* ------------------------------------------------------------------ */

/** Why a card landed in the Unmapped lane. Shown to the admin, not guessed. */
export type UnmappedReason =
  'unknown-team' | 'missing-column-value' | 'unknown-column' | 'no-mapping-row';

export type ForwardColumnResolution =
  | {
      readonly kind: 'mapped';
      readonly canonicalColumnId: string;
      readonly canonicalColumn: CanonicalColumn;
      readonly sourceColumnId: string;
      readonly sourceColumnName: string;
      readonly targetState: string | null;
      readonly isSplit: boolean;
    }
  | {
      readonly kind: 'unmapped';
      readonly canonicalColumnId: typeof UNMAPPED_COLUMN_ID;
      readonly sourceColumnName: string;
      readonly reason: UnmappedReason;
    };

const unmapped = (
  sourceColumnName: string,
  reason: UnmappedReason,
): ForwardColumnResolution => ({
  kind: 'unmapped',
  canonicalColumnId: UNMAPPED_COLUMN_ID,
  sourceColumnName,
  reason,
});

/**
 * Resolves the `WEF_<boardId>_Kanban.Column` value a card carries onto a
 * canonical column. Anything that cannot be resolved lands in the
 * Unmapped lane with the reason attached; nothing is ever guessed.
 */
export function resolveCanonicalColumn(
  index: MappingIndex,
  teamId: string,
  sourceColumnValue: string | null,
): ForwardColumnResolution {
  const name = sourceColumnValue?.trim() ?? '';
  const teamIndex = index.teams.get(teamId);
  if (teamIndex === undefined) return unmapped(name, 'unknown-team');
  if (name.length === 0) return unmapped(name, 'missing-column-value');

  const column =
    teamIndex.columnsByName.get(normalizeColumnKey(name)) ??
    teamIndex.columnsById.get(name);
  if (column === undefined) return unmapped(name, 'unknown-column');

  const mapping = teamIndex.mappingBySourceColumnId.get(column.id);
  if (mapping === undefined) return unmapped(column.name, 'no-mapping-row');

  const canonicalColumn = index.columnsById.get(mapping.canonicalColumnId);
  if (canonicalColumn === undefined) {
    return unmapped(column.name, 'no-mapping-row');
  }

  return {
    kind: 'mapped',
    canonicalColumnId: canonicalColumn.id,
    canonicalColumn,
    sourceColumnId: column.id,
    sourceColumnName: column.name,
    targetState: mapping.targetState,
    isSplit: column.isSplit,
  };
}

/* ------------------------------------------------------------------ */
/* Reverse: canonical column + team -> that team's column              */
/* ------------------------------------------------------------------ */

export type ReverseUnmappedReason =
  'unknown-team' | 'unknown-canonical-column' | 'no-mapping-row';

export type ReverseColumnResolution =
  | {
      readonly kind: 'mapped';
      readonly teamId: string;
      readonly canonicalColumnId: string;
      readonly sourceColumnId: string;
      readonly sourceColumnName: string;
      /** Set only when the write must also move `System.State`. */
      readonly targetState: string | null;
      readonly isSplit: boolean;
      /** The team's Azure DevOps board id, which names the WEF field. */
      readonly adoBoardId: string;
      readonly columnFieldName: string;
      /** The `.Done` companion, set only for a split target column. */
      readonly doneFieldName: string | null;
      /**
       * The value to write to that companion. A card dropped on a split
       * column lands in its Doing half, exactly as on a native board;
       * `null` means the field is not written at all.
       */
      readonly done: boolean | null;
    }
  | {
      readonly kind: 'refused';
      readonly teamId: string;
      readonly canonicalColumnId: string;
      readonly reason: ReverseUnmappedReason;
      /** Ready-to-render toast, exactly as the spec's failure table wants. */
      readonly failure: MappingMissingFailure;
    };

/**
 * Resolves a drop target back to the team's own column. A canonical
 * column the card's team has no mapping row for is refused with the
 * failure the hub renders, which is what makes the refusal possible
 * before the drag starts rather than after the write fails.
 */
export function resolveTeamColumnForCanonical(
  index: MappingIndex,
  teamId: string,
  canonicalColumnId: string,
): ReverseColumnResolution {
  const teamIndex = index.teams.get(teamId);
  const canonical = index.columnsById.get(canonicalColumnId);
  const refuse = (reason: ReverseUnmappedReason): ReverseColumnResolution => ({
    kind: 'refused',
    teamId,
    canonicalColumnId,
    reason,
    failure: mappingMissingFailure(index, teamId, canonicalColumnId),
  });

  if (teamIndex === undefined) return refuse('unknown-team');
  if (canonical === undefined) return refuse('unknown-canonical-column');

  const mapping = teamIndex.mappingByCanonicalColumnId.get(canonical.id);
  if (mapping === undefined) return refuse('no-mapping-row');

  const column =
    teamIndex.columnsById.get(mapping.sourceColumnId) ??
    teamIndex.columnsByName.get(normalizeColumnKey(mapping.sourceColumnId));

  const sourceColumnId = column?.id ?? mapping.sourceColumnId;
  const sourceColumnName = column?.name ?? mapping.sourceColumnId;
  const isSplit = column?.isSplit ?? false;

  return {
    kind: 'mapped',
    teamId,
    canonicalColumnId: canonical.id,
    sourceColumnId,
    sourceColumnName,
    targetState: mapping.targetState,
    isSplit,
    adoBoardId: teamIndex.team.adoBoardId,
    columnFieldName: teamIndex.team.columnFieldName,
    doneFieldName: isSplit ? teamIndex.team.doneFieldName : null,
    done: isSplit ? false : null,
  };
}

/** The drop-target allow-list a `BoardTeamView` carries. */
export function mappedCanonicalColumnIdsFor(
  index: MappingIndex,
  teamId: string,
): readonly string[] {
  return index.teams.get(teamId)?.mappedCanonicalColumnIds ?? [];
}

/** May this team's card be dropped on this canonical column at all? */
export function canTeamAcceptCanonicalColumn(
  index: MappingIndex,
  teamId: string,
  canonicalColumnId: string,
): boolean {
  if (canonicalColumnId === UNMAPPED_COLUMN_ID) return false;
  const teamIndex = index.teams.get(teamId);
  if (teamIndex === undefined) return false;
  return teamIndex.mappingByCanonicalColumnId.has(canonicalColumnId);
}

/** The `mapping-missing` failure, with the names the toast needs. */
export function mappingMissingFailure(
  index: MappingIndex,
  teamId: string,
  canonicalColumnId: string,
): MappingMissingFailure {
  const teamIndex = index.teams.get(teamId);
  const canonical = index.columnsById.get(canonicalColumnId);
  const teamName = teamIndex?.team.teamName ?? '';
  const columnName = canonical?.name ?? canonicalColumnId;
  const teamLabel = teamName.length > 0 ? teamName : teamId;
  return {
    reason: 'mapping-missing',
    message: `${teamLabel} has no column mapped to "${columnName}". Ask an admin to map it before moving cards there.`,
    projectId: teamIndex?.team.projectId ?? teamId,
    teamId,
    teamName,
    canonicalColumnId,
    canonicalColumnName: columnName,
  };
}

/* ------------------------------------------------------------------ */
/* Unmapped counts for the admin screen                                */
/* ------------------------------------------------------------------ */

/**
 * One entry per (team, source column) that stranded at least one card,
 * with the count the Unmapped lane and the admin mapping screen show.
 */
export function collectUnmappedColumns(
  cards: readonly BoardCard[],
  index: MappingIndex,
): UnmappedColumnRef[] {
  const byKey = new Map<string, UnmappedColumnRef>();
  for (const card of cards) {
    if (card.canonicalColumnId !== UNMAPPED_COLUMN_ID) continue;
    const team = index.teams.get(card.teamId)?.team;
    const sourceColumn = card.sourceColumn;
    const key = `${card.teamId}\u0000${normalizeColumnKey(sourceColumn)}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        projectId: team?.projectId ?? card.project,
        teamId: card.teamId,
        teamName: team?.teamName ?? '',
        sourceColumn,
        cardCount: 1,
      });
      continue;
    }
    byKey.set(key, { ...existing, cardCount: existing.cardCount + 1 });
  }

  return [...byKey.values()].sort(
    (a, b) =>
      compareStrings(a.projectId, b.projectId) ||
      compareStrings(a.teamName, b.teamName) ||
      compareStrings(a.teamId, b.teamId) ||
      compareStrings(a.sourceColumn, b.sourceColumn),
  );
}
