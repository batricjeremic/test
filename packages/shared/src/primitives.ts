/**
 * Primitive value shapes reused across every shared DTO.
 *
 * Spec: "Domain model and column mapping". Kept dependency-free so the
 * package can be imported by the React hub as well as the BFF.
 */
import { z } from 'zod';

/** A non-empty string. Used for every id-like field. */
export const nonEmptyStringSchema = z.string().min(1);

/**
 * Azure DevOps identity descriptor. Stable across every project in one
 * organization, which is why one person maps to exactly one swimlane.
 */
export const descriptorSchema = z.string().min(1);
export type Descriptor = z.infer<typeof descriptorSchema>;

/** Calendar date, `YYYY-MM-DD`. Used for user-chosen date windows. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'must be an ISO calendar date (YYYY-MM-DD)',
});
export type IsoDate = z.infer<typeof isoDateSchema>;

/** Instant in time, ISO-8601 with offset, e.g. `2026-09-17T08:00:00Z`. */
export const isoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/**
 * Identity as `System.AssignedTo` resolves it. `displayName` is personal
 * data: render it, never write it to a log line.
 */
export const identityRefSchema = z.object({
  descriptor: descriptorSchema,
  displayName: z.string(),
});
export type IdentityRef = z.infer<typeof identityRefSchema>;

/** Correlation id carried on every request, log line and realtime frame. */
export const traceIdSchema = z.string().min(1);
export type TraceId = z.infer<typeof traceIdSchema>;
