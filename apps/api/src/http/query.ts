/**
 * The query string of `GET /api/boards/{boardId}/sprint`, turned into the
 * shared `BoardSnapshotQuery`.
 *
 * Spec: "Iteration alignment" gives the three modes, and "Scope and
 * non-goals" gives the filter set. A query string carries only strings,
 * so this module is the one place that widens them — and it does it with
 * Zod, so a caller can never smuggle a shape past the schemas.
 */
import { boardSnapshotQuerySchema, nonEmptyStringSchema } from '@eg/shared';
import type { BoardSnapshotQuery } from '@eg/shared';
import { z } from 'zod';
import { parseWith } from './context.js';

/** `?window=` values, matching the spec's alignment modes. */
export const SNAPSHOT_WINDOWS = [
  'current',
  'date-window',
  'named-iteration',
] as const;
export type SnapshotWindow = (typeof SNAPSHOT_WINDOWS)[number];

/** A repeated or comma-separated query parameter, as a list. */
const listParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  });

const booleanParam = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((value) => value === true || value === 'true' || value === '1');

export const snapshotQueryParamsSchema = z.object({
  window: z.enum(SNAPSHOT_WINDOWS).default('current'),
  start: z.string().optional(),
  end: z.string().optional(),
  iterationPath: z.string().optional(),
  grouping: z.enum(['person', 'team']).optional(),
  projectIds: listParam,
  teamIds: listParam,
  workItemTypes: listParam,
  tags: listParam,
  states: listParam,
  unassignedOnly: booleanParam,
});
export type SnapshotQueryParams = z.infer<typeof snapshotQueryParamsSchema>;

const alignmentFor = (params: SnapshotQueryParams): unknown => {
  switch (params.window) {
    case 'date-window':
      return {
        mode: 'date-window',
        window: { start: params.start ?? '', end: params.end ?? '' },
      };
    case 'named-iteration':
      return {
        mode: 'named-iteration',
        iterationPath: params.iterationPath ?? '',
      };
    default:
      return { mode: 'each-team-current' };
  }
};

/**
 * `?window=current` and friends, validated twice: once as query
 * parameters, once as the shared snapshot query, so the defaults the hub
 * relies on come from `@eg/shared` and not from here.
 */
export function parseSnapshotQuery(raw: unknown): BoardSnapshotQuery {
  const params = parseWith(snapshotQueryParamsSchema, raw, 'query string');
  return parseWith(
    boardSnapshotQuerySchema,
    {
      alignment: alignmentFor(params),
      grouping: params.grouping ?? null,
      filters: {
        projectIds: params.projectIds,
        teamIds: params.teamIds,
        workItemTypes: params.workItemTypes,
        tags: params.tags,
        states: params.states,
        unassignedOnly: params.unassignedOnly,
      },
    },
    'board query',
  );
}

const boardParamsSchema = z.object({ boardId: nonEmptyStringSchema });

/** The `:boardId` path parameter. Never trusted beyond being a string. */
export function parseBoardIdParam(raw: unknown): string {
  return parseWith(boardParamsSchema, raw, 'board id').boardId;
}
