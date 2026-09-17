/**
 * The write path: one drag, one move request, one confirmed result.
 *
 * Spec: "Write path". A move is never reported as saved until Azure
 * DevOps confirms it, and every failure carries exactly the data the hub
 * needs to write the toast the spec describes.
 */
import { z } from 'zod';
import { boardCardSchema } from './board.js';
import {
  identityRefSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from './primitives.js';

/** `POST /api/moves` — id, rev and target column, as the spec's diagram. */
export const moveRequestSchema = z.object({
  boardId: nonEmptyStringSchema,
  workItemId: z.number().int().positive(),
  /** The rev the user's card carried; sent as a JSON Patch `test` op. */
  rev: z.number().int().nonnegative(),
  /** Where the card came from. Recorded on the audit entry. */
  fromCanonicalColumnId: nonEmptyStringSchema,
  toCanonicalColumnId: nonEmptyStringSchema,
});
export type MoveRequest = z.infer<typeof moveRequestSchema>;

/** Stable reasons, mirroring the spec's write-failure table row for row. */
export const moveFailureReasonSchema = z.enum([
  'revision-conflict',
  'rule-violation',
  'transition-not-allowed',
  'permission-denied',
  'mapping-missing',
  'service-unavailable',
]);
export type MoveFailureReason = z.infer<typeof moveFailureReasonSchema>;
export const MOVE_FAILURE_REASONS = moveFailureReasonSchema.options;

/** Card changed since load. Toast: "Ana moved this to Done a moment ago". */
export const revisionConflictFailureSchema = z.object({
  reason: z.literal('revision-conflict'),
  message: z.string(),
  currentRev: z.number().int().nonnegative(),
  currentCanonicalColumnId: nonEmptyStringSchema,
  currentColumnName: z.string(),
  changedBy: identityRefSchema.nullable(),
  changedAt: isoTimestampSchema.nullable(),
});

/** Required field empty for the target state. Toast names the field. */
export const ruleViolationFailureSchema = z.object({
  reason: z.literal('rule-violation'),
  message: z.string(),
  /** Reference name, e.g. `Microsoft.VSTS.Common.Activity`. */
  field: nonEmptyStringSchema,
  fieldDisplayName: z.string(),
  targetState: z.string().nullable(),
  /** Deep link for the "open the work item form" button on the toast. */
  workItemUrl: z.string().url(),
});

/** Process forbids that state change. Toast names the allowed next states. */
export const transitionNotAllowedFailureSchema = z.object({
  reason: z.literal('transition-not-allowed'),
  message: z.string(),
  fromState: z.string(),
  toState: z.string(),
  allowedStates: z.array(z.string()),
});

/** User lacks write in that project; the card should not have been dragged. */
export const permissionDeniedFailureSchema = z.object({
  reason: z.literal('permission-denied'),
  message: z.string(),
  projectId: nonEmptyStringSchema,
  projectName: z.string(),
});

/** Target column not mapped for that team; the drop is refused at drag start. */
export const mappingMissingFailureSchema = z.object({
  reason: z.literal('mapping-missing'),
  message: z.string(),
  projectId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  teamName: z.string(),
  canonicalColumnId: nonEmptyStringSchema,
  canonicalColumnName: z.string(),
});

/** Azure DevOps 5xx or throttle, after the two retries with backoff. */
export const serviceUnavailableFailureSchema = z.object({
  reason: z.literal('service-unavailable'),
  message: z.string(),
  attempts: z.number().int().positive(),
  retryAfterSeconds: z.number().nonnegative().nullable(),
});

export const moveFailureSchema = z.discriminatedUnion('reason', [
  revisionConflictFailureSchema,
  ruleViolationFailureSchema,
  transitionNotAllowedFailureSchema,
  permissionDeniedFailureSchema,
  mappingMissingFailureSchema,
  serviceUnavailableFailureSchema,
]);
export type MoveFailure = z.infer<typeof moveFailureSchema>;
export type RevisionConflictFailure = z.infer<
  typeof revisionConflictFailureSchema
>;
export type RuleViolationFailure = z.infer<typeof ruleViolationFailureSchema>;
export type TransitionNotAllowedFailure = z.infer<
  typeof transitionNotAllowedFailureSchema
>;
export type PermissionDeniedFailure = z.infer<
  typeof permissionDeniedFailureSchema
>;
export type MappingMissingFailure = z.infer<typeof mappingMissingFailureSchema>;
export type ServiceUnavailableFailure = z.infer<
  typeof serviceUnavailableFailureSchema
>;

/**
 * The result of one move. `applied` carries the card as Azure DevOps now
 * holds it, including the new rev. `failed` carries the reason and, where
 * we were able to re-read it, the authoritative card to snap back to.
 */
export const moveResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    workItemId: z.number().int().positive(),
    card: boardCardSchema,
    /** True when the mapping carried a targetState and state moved too. */
    stateChanged: z.boolean(),
  }),
  z.object({
    status: z.literal('failed'),
    workItemId: z.number().int().positive(),
    failure: moveFailureSchema,
    card: boardCardSchema.nullable(),
  }),
]);
export type MoveResult = z.infer<typeof moveResultSchema>;
export type MoveApplied = Extract<MoveResult, { status: 'applied' }>;
export type MoveFailed = Extract<MoveResult, { status: 'failed' }>;
