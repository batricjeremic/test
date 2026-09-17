/**
 * Audit log.
 *
 * Spec: "Write path" — every write attempt is written to `AuditEntry`,
 * including the failures, because the first support question will be
 * "I moved that card and it went back".
 */
import { z } from 'zod';
import { moveFailureSchema } from './move.js';
import {
  descriptorSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  traceIdSchema,
} from './primitives.js';

/** Outcome of one write attempt. */
export const auditResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    newRev: z.number().int().nonnegative(),
    stateChanged: z.boolean(),
  }),
  z.object({
    outcome: z.literal('failure'),
    failure: moveFailureSchema,
  }),
]);
export type AuditResult = z.infer<typeof auditResultSchema>;

/**
 * One row per write attempt. `actor` is the caller's identity descriptor,
 * never a display name or an email: this row is durable storage.
 */
export const auditEntrySchema = z.object({
  /** Assigned by the config store on append. */
  id: nonEmptyStringSchema,
  boardId: nonEmptyStringSchema,
  actor: descriptorSchema,
  workItemId: z.number().int().positive(),
  /** Canonical column id the card came from. */
  from: nonEmptyStringSchema,
  /** Canonical column id the card was dropped on. */
  to: nonEmptyStringSchema,
  result: auditResultSchema,
  timestamp: isoTimestampSchema,
  /** Ties the row to the request's log lines. */
  traceId: traceIdSchema,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** An entry before the store assigns its id. */
export const newAuditEntrySchema = auditEntrySchema.omit({ id: true });
export type NewAuditEntry = z.infer<typeof newAuditEntrySchema>;
