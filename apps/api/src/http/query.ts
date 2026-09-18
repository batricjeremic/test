/**
 * The query string of `GET /api/boards/{boardId}/sprint`, turned into the
 * shared `BoardSnapshotQuery`.
 *
 * Spec: "Iteration alignment" gives the three modes, and "Scope and
 * non-goals" gives the filter set. A query string carries only strings,
 * so this module is the one place that widens them — and it does it with
 * Zod, so a caller can never smuggle a shape past the schemas.
 */
import {
  boardQueryCandidate,
  boardQueryParamsFrom,
  boardSnapshotQuerySchema,
  nonEmptyStringSchema,
} from '@eg/shared';
import type { BoardSnapshotQuery } from '@eg/shared';
import { z } from 'zod';
import { parseWith } from './context.js';

/**
 * The snapshot query, decoded by the SAME code the hub encodes it with.
 *
 * This file used to have its own parameter names — `window`, `projectIds`,
 * `workItemTypes`, `unassignedOnly` — while the hub sent `mode`,
 * `projects`, `types`, `unassigned`. Only `tags` and `states` coincided,
 * so only those two filters ever worked, and the alignment picker was a
 * silent no-op because `mode` was never read. Nothing failed loudly: an
 * unknown query parameter is ignored, not rejected.
 *
 * The names and the encoding now live in `@eg/shared`, so there is no
 * second spelling to drift from.
 */
export function parseSnapshotQuery(raw: unknown): BoardSnapshotQuery {
  return parseWith(
    boardSnapshotQuerySchema,
    boardQueryCandidate(boardQueryParamsFrom(raw)),
    'board query',
  );
}

const boardParamsSchema = z.object({ boardId: nonEmptyStringSchema });

/** The `:boardId` path parameter. Never trusted beyond being a string. */
export function parseBoardIdParam(raw: unknown): string {
  return parseWith(boardParamsSchema, raw, 'board id').boardId;
}
