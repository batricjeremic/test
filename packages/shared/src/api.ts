/**
 * The BFF's read surface: what `GET /api/boards/{boardId}/sprint` takes
 * and returns.
 *
 * Spec: "Request flow for a board load", "Auth, permissions and security".
 */
import { z } from 'zod';
import {
  boardCardSchema,
  boardGroupingSchema,
  canonicalColumnSchema,
  backlogLevelSchema,
  unmappedColumnRefSchema,
} from './board.js';
import { personLoadSchema } from './capacity.js';
import { boardFilterSetSchema } from './filters.js';
import {
  burndownAvailabilitySchema,
  DEFAULT_ITERATION_ALIGNMENT,
  iterationAlignmentSchema,
  teamIterationWindowSchema,
} from './iteration.js';
import {
  descriptorSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  traceIdSchema,
} from './primitives.js';
import { realtimeStatusSchema } from './realtime.js';

/** Query for a board snapshot. Every part has a defined default. */
export const boardSnapshotQuerySchema = z.object({
  alignment: iterationAlignmentSchema.default(DEFAULT_ITERATION_ALIGNMENT),
  /** Null falls back to the board definition's `defaultGrouping`. */
  grouping: boardGroupingSchema.nullable().default(null),
  filters: boardFilterSetSchema.default({}),
});
export type BoardSnapshotQuery = z.infer<typeof boardSnapshotQuerySchema>;
export type BoardSnapshotQueryInput = z.input<typeof boardSnapshotQuerySchema>;

/**
 * One team board merged into this board, with everything the hub needs to
 * decide whether a card may be dragged and where it may be dropped.
 * Project and team display names live on `iteration`.
 */
export const boardTeamViewSchema = z.object({
  projectId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  backlogLevel: backlogLevelSchema,
  iteration: teamIterationWindowSchema,
  /**
   * Canonical columns this team has a mapping row for. A drop onto any
   * other column is refused at drag start and shown as blocked.
   */
  mappedCanonicalColumnIds: z.array(nonEmptyStringSchema),
  /** False renders the team's lanes dimmed and its cards undraggable. */
  writable: z.boolean(),
});
export type BoardTeamView = z.infer<typeof boardTeamViewSchema>;

/**
 * One swimlane. `hiddenCardCount` is what security trimming removed: an
 * empty lane is still shown with a count, so a person knows something
 * exists without seeing what.
 */
export const boardSwimlaneSchema = z.object({
  id: nonEmptyStringSchema,
  kind: z.enum(['person', 'team', 'unassigned']),
  label: z.string(),
  /** Set when `kind` is `person`. */
  personDescriptor: descriptorSchema.nullable(),
  /** Set when `kind` is `team`. */
  teamId: nonEmptyStringSchema.nullable(),
  /** Ascending render order. The unassigned lane is pinned at the top. */
  order: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  hiddenCardCount: z.number().int().nonnegative(),
  /** Lane headers show hours and card count side by side. */
  remainingWorkHours: z.number().nonnegative(),
  cardsWithoutRemainingWork: z.number().int().nonnegative(),
});
export type BoardSwimlane = z.infer<typeof boardSwimlaneSchema>;

/** What this caller may read and write, after ACL resolution. */
export const boardPermissionsSchema = z.object({
  descriptor: descriptorSchema,
  readableProjectIds: z.array(nonEmptyStringSchema),
  writableProjectIds: z.array(nonEmptyStringSchema),
  /** May edit board definitions, sources, columns and mappings. */
  canAdminister: z.boolean(),
});
export type BoardPermissions = z.infer<typeof boardPermissionsSchema>;

/** Where the snapshot came from, so the hub can show a stale/degraded hint. */
export const snapshotCacheInfoSchema = z.object({
  hit: z.boolean(),
  ageSeconds: z.number().nonnegative(),
  /** True when the cache was unavailable and we served a live fan-out. */
  degraded: z.boolean(),
});
export type SnapshotCacheInfo = z.infer<typeof snapshotCacheInfoSchema>;

/** Everything one board load returns. */
export const boardSnapshotSchema = z.object({
  boardId: nonEmptyStringSchema,
  boardName: z.string(),
  orgId: nonEmptyStringSchema,
  generatedAt: isoTimestampSchema,
  traceId: traceIdSchema,
  cache: snapshotCacheInfoSchema,
  grouping: boardGroupingSchema,
  alignment: iterationAlignmentSchema,
  filters: boardFilterSetSchema,
  columns: z.array(canonicalColumnSchema),
  teams: z.array(boardTeamViewSchema),
  swimlanes: z.array(boardSwimlaneSchema),
  cards: z.array(boardCardSchema),
  /** One entry per person in scope, whatever the grouping. */
  personLoad: z.array(personLoadSchema),
  unmappedColumns: z.array(unmappedColumnRefSchema),
  permissions: boardPermissionsSchema,
  realtime: realtimeStatusSchema,
  burndown: burndownAvailabilitySchema,
  /** Total cards removed by security trimming across every lane. */
  hiddenCardCount: z.number().int().nonnegative(),
});
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

/**
 * The body of any non-2xx response from the BFF. `code` is stable and
 * machine-readable; `message` is safe to show to the user.
 */
export const apiErrorSchema = z.object({
  code: nonEmptyStringSchema,
  message: z.string(),
  status: z.number().int().min(400).max(599),
  traceId: traceIdSchema,
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
