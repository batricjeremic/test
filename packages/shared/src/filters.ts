/**
 * Board filters.
 *
 * Spec: "Scope and non-goals" — filters are project, team, work item
 * type, tag, state and unassigned. Empty arrays mean "no restriction".
 */
import { z } from 'zod';
import { nonEmptyStringSchema } from './primitives.js';

export const boardFilterSetSchema = z.object({
  projectIds: z.array(nonEmptyStringSchema).default([]),
  teamIds: z.array(nonEmptyStringSchema).default([]),
  workItemTypes: z.array(nonEmptyStringSchema).default([]),
  tags: z.array(nonEmptyStringSchema).default([]),
  states: z.array(nonEmptyStringSchema).default([]),
  /** Show only cards assigned to a group or to nobody. */
  unassignedOnly: z.boolean().default(false),
});
export type BoardFilterSet = z.infer<typeof boardFilterSetSchema>;
/** What callers send: every key is optional and defaults to unfiltered. */
export type BoardFilterSetInput = z.input<typeof boardFilterSetSchema>;

export const EMPTY_BOARD_FILTER_SET: BoardFilterSet = {
  projectIds: [],
  teamIds: [],
  workItemTypes: [],
  tags: [],
  states: [],
  unassignedOnly: false,
};
