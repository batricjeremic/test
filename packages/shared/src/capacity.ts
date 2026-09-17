/**
 * Per-person capacity and load.
 *
 * Spec: "Capacity and the per-person view". A person on three teams has
 * three capacity records; this is the rolled-up shape, with the markers
 * the edge-case table requires so a partial answer never reads as a
 * complete one.
 */
import { z } from 'zod';
import {
  descriptorSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from './primitives.js';

/**
 * One person's contribution from one team. Capacity is computed over that
 * team's own iteration dates, then summed, so teams with different
 * iteration lengths stay correct.
 */
export const personTeamCapacitySchema = z.object({
  projectId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  teamName: z.string(),
  iterationId: nonEmptyStringSchema,
  /**
   * False when the person has no capacity record on this team. Capacity is
   * then treated as zero and the person is flagged `partialCapacity`.
   */
  hasCapacityRecord: z.boolean(),
  /** Sum of the member's activity capacities, hours per working day. */
  capacityPerDay: z.number().nonnegative(),
  /** Working days in this team's iteration. */
  workingDays: z.number().int().nonnegative(),
  /** Working days removed by personal days off and team days off. */
  daysOff: z.number().int().nonnegative(),
  /** capacityPerDay x (workingDays - daysOff). */
  capacityHours: z.number().nonnegative(),
  /** Sum of RemainingWork on this team's cards assigned to the person. */
  committedHours: z.number().nonnegative(),
  cardCount: z.number().int().nonnegative(),
});
export type PersonTeamCapacity = z.infer<typeof personTeamCapacitySchema>;

/**
 * The single bar a person gets, whatever number of teams they are on.
 * `load` is `committedHours / capacityHours` and is null when capacity is
 * zero, because a bar with no denominator must not render as 0%.
 */
export const personLoadSchema = z.object({
  descriptor: descriptorSchema,
  /** Display name after PersonOverride is applied. Personal data. */
  displayName: z.string(),
  /** True when a PersonOverride hides this person from the board. */
  hidden: z.boolean(),
  capacityHours: z.number().nonnegative(),
  committedHours: z.number().nonnegative(),
  load: z.number().nonnegative().nullable(),
  /**
   * At least one of the person's in-scope teams had no capacity record.
   * The bar shows a partial-capacity marker rather than looking
   * under-loaded.
   */
  partialCapacity: z.boolean(),
  /**
   * Teams this person is on that the board does not cover. Rendered as a
   * footnote count so nobody reads the bar as complete.
   */
  outOfScopeTeamCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  /**
   * Cards with no RemainingWork. Counted in `cardCount`, excluded from
   * `committedHours`; lane headers show both numbers.
   */
  cardsWithoutRemainingWork: z.number().int().nonnegative(),
  /** Per-team split, shown on hover rather than as separate rows. */
  perTeam: z.array(personTeamCapacitySchema),
  computedAt: isoTimestampSchema,
});
export type PersonLoad = z.infer<typeof personLoadSchema>;

/** Threshold marker on the load bar: at or above this, the person is over. */
export const DEFAULT_LOAD_THRESHOLD = 1;
