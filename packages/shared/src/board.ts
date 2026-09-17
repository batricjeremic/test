/**
 * Board definition, column mapping and the card DTO.
 *
 * Spec: "Domain model and column mapping". These are the saved objects an
 * admin configures once, plus the card shape the hub renders.
 */
import { z } from 'zod';
import {
  descriptorSchema,
  identityRefSchema,
  nonEmptyStringSchema,
} from './primitives.js';

/** Grouping union: swimlane per assignee, or swimlane per team. */
export const boardGroupingSchema = z.enum(['person', 'team']);
export type BoardGrouping = z.infer<typeof boardGroupingSchema>;
export const BOARD_GROUPINGS = boardGroupingSchema.options;

/** `CanonicalColumn.stateCategory` is Proposed, InProgress or Completed. */
export const stateCategorySchema = z.enum([
  'Proposed',
  'InProgress',
  'Completed',
]);
export type StateCategory = z.infer<typeof stateCategorySchema>;
export const STATE_CATEGORIES = stateCategorySchema.options;

/**
 * Backlog level reference name of the team board being merged,
 * e.g. `Microsoft.RequirementCategory` or `Microsoft.TaskCategory`.
 */
export const backlogLevelSchema = nonEmptyStringSchema;
export type BacklogLevel = z.infer<typeof backlogLevelSchema>;

/** One saved board per audience, e.g. "Delivery — all divisions". */
export const boardDefinitionSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  orgId: nonEmptyStringSchema,
  defaultGrouping: boardGroupingSchema,
  ownerDescriptor: descriptorSchema,
});
export type BoardDefinition = z.infer<typeof boardDefinitionSchema>;

/** The set of team boards being merged into one board definition. */
export const boardSourceSchema = z.object({
  boardId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  backlogLevel: backlogLevelSchema,
});
export type BoardSource = z.infer<typeof boardSourceSchema>;

/** A column declared once on our board, onto which team columns map. */
export const canonicalColumnSchema = z.object({
  id: nonEmptyStringSchema,
  boardId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  order: z.number().int().nonnegative(),
  stateCategory: stateCategorySchema,
});
export type CanonicalColumn = z.infer<typeof canonicalColumnSchema>;

/**
 * One team column mapped onto one canonical column. `targetState` is
 * optional and set only when the write must also move `System.State`;
 * `null` means the move writes the board column alone.
 */
export const columnMappingSchema = z.object({
  boardId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  sourceColumnId: nonEmptyStringSchema,
  canonicalColumnId: nonEmptyStringSchema,
  targetState: z.string().min(1).nullable(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

/** Display tidying for contractors and shared accounts. Never correctness. */
export const personOverrideSchema = z.object({
  boardId: nonEmptyStringSchema,
  descriptor: descriptorSchema,
  displayName: z.string(),
  hidden: z.boolean(),
});
export type PersonOverride = z.infer<typeof personOverrideSchema>;

/**
 * The card as the hub renders it. Field names and nullability are fixed by
 * the spec's TypeScript block; `rev` exists for optimistic concurrency and
 * is echoed back on every move request.
 */
export const boardCardSchema = z.object({
  workItemId: z.number().int().positive(),
  project: nonEmptyStringSchema,
  /** Owning team, resolved from area path. */
  teamId: nonEmptyStringSchema,
  /** That team's iteration for this window. */
  iterationId: nonEmptyStringSchema,
  title: z.string(),
  /** User Story, Bug, Task. */
  type: nonEmptyStringSchema,
  assignedTo: identityRefSchema.nullable(),
  /** Native work item state. */
  state: z.string(),
  /** `WEF_<boardId>_Kanban.Column` value. */
  sourceColumn: z.string(),
  /** Resolved via ColumnMapping; `UNMAPPED_COLUMN_ID` when there is none. */
  canonicalColumnId: nonEmptyStringSchema,
  remainingWork: z.number().nullable(),
  tags: z.array(z.string()),
  /** For optimistic concurrency on write. */
  rev: z.number().int().nonnegative(),
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/**
 * Canonical column id for cards whose team column has no mapping row.
 * Unmapped columns are never guessed: the card lands in a visible lane.
 */
export const UNMAPPED_COLUMN_ID = '__unmapped__';

/** Swimlane id for cards assigned to a group or to nobody. Pinned first. */
export const UNASSIGNED_LANE_ID = '__unassigned__';

/**
 * One (team, source column) pair with no mapping row, plus how many cards
 * are stranded in it. Rendered in the Unmapped lane and counted on the
 * admin mapping screen.
 */
export const unmappedColumnRefSchema = z.object({
  projectId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  teamName: z.string(),
  sourceColumn: z.string(),
  cardCount: z.number().int().nonnegative(),
});
export type UnmappedColumnRef = z.infer<typeof unmappedColumnRefSchema>;

/* ------------------------------------------------------------------ */
/* The directory behind the source picker                              */
/* ------------------------------------------------------------------ */

/**
 * What an admin picks from when adding a source.
 *
 * These exist because the first real board was configured by copying
 * GUIDs out of Azure DevOps URLs by hand — a team id is nowhere on the
 * screen in Azure DevOps, and a mistyped one fails silently later rather
 * than at the point of typing. The BFF reads them under the CALLER's own
 * identity, not the service identity, so the list is the one that person
 * is allowed to see rather than everything in the organisation.
 */
export const adoProjectRefSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});
export type AdoProjectRef = z.infer<typeof adoProjectRefSchema>;

export const adoTeamRefSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});
export type AdoTeamRef = z.infer<typeof adoTeamRefSchema>;

/**
 * A team's board, which is what `BoardSource.backlogLevel` names. It is
 * matched on id first and then on name, so either is a valid value —
 * the picker sends the id.
 */
export const adoTeamBoardRefSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});
export type AdoTeamBoardRef = z.infer<typeof adoTeamBoardRefSchema>;
