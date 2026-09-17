/**
 * Admin-screen local types.
 *
 * Every persisted shape comes from `@eg/shared`; nothing here redeclares
 * one. These types describe the in-browser editing session only: the
 * draft the admin is holding, and the team-column view the mapping
 * matrix is rendered from.
 */
import type {
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';

/** Which part of the screen a validation issue or change belongs to. */
export type AdminSection =
  'definition' | 'sources' | 'columns' | 'mappings' | 'overrides';

/**
 * Everything the admin screen edits, held as one value so validation,
 * the change summary and the save path all see the same thing.
 */
export type AdminDraft = {
  readonly definition: BoardDefinition;
  readonly sources: readonly BoardSource[];
  readonly columns: readonly CanonicalColumn[];
  readonly mappings: readonly ColumnMapping[];
  readonly overrides: readonly PersonOverride[];
};

/**
 * One column on one team's own board, as the matrix renders it.
 *
 * Azure DevOps has no cross-project column catalogue, so the set of a
 * team's columns is reconstructed from what we already know about it:
 * the mapping rows an admin has written, and the unmapped columns the
 * snapshot reports cards stranded in. An admin can name one we have
 * never seen.
 */
export type TeamColumnRef = {
  readonly teamId: string;
  readonly projectId: string;
  readonly teamName: string;
  readonly projectName: string;
  /** `WEF_<boardId>_Kanban.Column` value, keyed the way the BFF keys it. */
  readonly sourceColumnId: string;
  /** Cards currently stranded in this column, when it is unmapped. */
  readonly cardCount: number;
};

/** One team the board merges, with its own columns. */
export type AdminTeam = {
  readonly teamId: string;
  readonly projectId: string;
  readonly teamName: string;
  readonly projectName: string;
  readonly backlogLevels: readonly string[];
  readonly columns: readonly TeamColumnRef[];
};

/** A reason the draft may not be written, shown next to its section. */
export type AdminValidationIssue = {
  readonly section: AdminSection;
  readonly message: string;
};
