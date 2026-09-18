/**
 * The board query, re-exported from `@eg/shared`.
 *
 * It used to live here, and the BFF had its own parser with different
 * parameter names — so only the two filters whose names happened to
 * coincide ever worked, and the alignment picker did nothing at all. The
 * encoding now has one owner; this module exists so the hub's imports do
 * not all have to change.
 */
export {
  BOARD_QUERY_PARAM_KEYS,
  decodeBoardQuery,
  encodeBoardQuery,
  mergeBoardQuery,
} from '@eg/shared';
export type { BoardSnapshotQuery as BoardQuery } from '@eg/shared';

import { DEFAULT_BOARD_SNAPSHOT_QUERY } from '@eg/shared';

export const DEFAULT_BOARD_QUERY = DEFAULT_BOARD_SNAPSHOT_QUERY;
