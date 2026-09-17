/**
 * Realtime card deltas.
 *
 * Spec: "Caching, rate limits and realtime". A service hook on
 * `workitem.updated` invalidates the snapshot and pushes a delta to every
 * open board, so two people dragging cards see each other.
 */
import { z } from 'zod';
import { boardCardSchema } from './board.js';
import {
  identityRefSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  traceIdSchema,
} from './primitives.js';

/** Wire version of the envelope. Bump only for a breaking frame change. */
export const REALTIME_PROTOCOL_VERSION = 1;

/** A card entered the board's scope, or any of its fields changed. */
export const cardUpsertedDeltaSchema = z.object({
  kind: z.literal('card-upserted'),
  card: boardCardSchema,
});

/** A card changed canonical column. Enough to animate without a refetch. */
export const cardMovedDeltaSchema = z.object({
  kind: z.literal('card-moved'),
  workItemId: z.number().int().positive(),
  rev: z.number().int().nonnegative(),
  fromCanonicalColumnId: nonEmptyStringSchema,
  toCanonicalColumnId: nonEmptyStringSchema,
  sourceColumn: z.string(),
  state: z.string(),
  assignedTo: identityRefSchema.nullable(),
});

/** A card left the board: deleted, reassigned out of scope, or resprinted. */
export const cardRemovedDeltaSchema = z.object({
  kind: z.literal('card-removed'),
  workItemId: z.number().int().positive(),
  cause: z.enum(['deleted', 'out-of-scope', 'iteration-changed']),
});

export const cardDeltaSchema = z.discriminatedUnion('kind', [
  cardUpsertedDeltaSchema,
  cardMovedDeltaSchema,
  cardRemovedDeltaSchema,
]);
export type CardDelta = z.infer<typeof cardDeltaSchema>;
export type CardUpsertedDelta = z.infer<typeof cardUpsertedDeltaSchema>;
export type CardMovedDelta = z.infer<typeof cardMovedDeltaSchema>;
export type CardRemovedDelta = z.infer<typeof cardRemovedDeltaSchema>;

/** What caused the push. `own-write` lets a client skip its own echo. */
export const deltaOriginSchema = z.enum([
  'service-hook',
  'own-write',
  'sync-worker',
]);
export type DeltaOrigin = z.infer<typeof deltaOriginSchema>;

/** Every frame on a board channel is one of these. */
export const realtimeEnvelopeSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  boardId: nonEmptyStringSchema,
  channel: nonEmptyStringSchema,
  /** Monotonic per channel; a gap tells the hub to refetch the snapshot. */
  sequence: z.number().int().nonnegative(),
  emittedAt: isoTimestampSchema,
  traceId: traceIdSchema,
  origin: deltaOriginSchema,
  delta: cardDeltaSchema,
});
export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;

/**
 * Whether the board is live. When service hooks are unavailable the hub
 * polls and shows a quiet "live updates off" indicator, so degraded mode
 * is visible rather than silent.
 */
export const realtimeStatusSchema = z.object({
  mode: z.enum(['live', 'polling']),
  channel: nonEmptyStringSchema,
  /** Poll interval to use while in `polling` mode. Spec default: 30 s. */
  pollIntervalSeconds: z.number().int().positive(),
  reason: z
    .enum(['service-hooks-missing', 'cache-unavailable', 'client-fallback'])
    .nullable(),
});
export type RealtimeStatus = z.infer<typeof realtimeStatusSchema>;

/** Spec default poll interval when live updates are off. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
