/**
 * Iteration alignment.
 *
 * Spec: "Iteration alignment". Teams may run different cadences, so
 * "this sprint" is a choice the caller makes explicitly.
 */
import { z } from 'zod';
import {
  isoDateSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from './primitives.js';

/** The three alignment modes, as bare discriminator values. */
export const iterationAlignmentModeSchema = z.enum([
  'each-team-current',
  'date-window',
  'named-iteration',
]);
export type IterationAlignmentMode = z.infer<
  typeof iterationAlignmentModeSchema
>;
export const ITERATION_ALIGNMENT_MODES = iterationAlignmentModeSchema.options;

/** Inclusive calendar range parameter for `date-window`. */
export const dateWindowSchema = z
  .object({
    start: isoDateSchema,
    end: isoDateSchema,
  })
  .refine((w) => w.start <= w.end, {
    message: 'start must not be after end',
    path: ['start'],
  });
export type DateWindow = z.infer<typeof dateWindowSchema>;

/**
 * Alignment mode with its parameters. `each-team-current` is the default
 * and carries none; `date-window` carries the chosen range; the
 * `named-iteration` mode carries one iteration path shared across teams.
 */
export const iterationAlignmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('each-team-current') }),
  z.object({ mode: z.literal('date-window'), window: dateWindowSchema }),
  z.object({
    mode: z.literal('named-iteration'),
    iterationPath: nonEmptyStringSchema,
  }),
]);
export type IterationAlignment = z.infer<typeof iterationAlignmentSchema>;

/** The default alignment: every team's own `@CurrentIteration`, merged. */
export const DEFAULT_ITERATION_ALIGNMENT: IterationAlignment = {
  mode: 'each-team-current',
};

/**
 * One team's resolved iteration for the selected window. Carried on team
 * badges and swimlane headers so a reader can see that one team is on day
 * 2 of 15 while another is on day 8 of 10.
 */
export const teamIterationWindowSchema = z.object({
  projectId: nonEmptyStringSchema,
  projectName: z.string(),
  teamId: nonEmptyStringSchema,
  teamName: z.string(),
  iterationId: nonEmptyStringSchema,
  iterationPath: z.string(),
  iterationName: z.string(),
  startDate: isoTimestampSchema.nullable(),
  finishDate: isoTimestampSchema.nullable(),
  /** Working days in this team's iteration, from its own working-days set. */
  workingDaysTotal: z.number().int().nonnegative(),
  /** Working days elapsed at snapshot time; never exceeds the total. */
  workingDaysElapsed: z.number().int().nonnegative(),
});
export type TeamIterationWindow = z.infer<typeof teamIterationWindowSchema>;

/**
 * Burndown is deliberately absent when windows are mismatched, because a
 * burndown over mismatched windows is a lie. The snapshot says so rather
 * than leaving the hub to guess.
 */
export const burndownAvailabilitySchema = z.enum([
  'available',
  'suppressed-mismatched-windows',
]);
export type BurndownAvailability = z.infer<typeof burndownAvailabilitySchema>;
