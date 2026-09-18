/**
 * The board query on the wire, encoded and decoded in ONE place.
 *
 * It used to be two: the hub wrote `?mode=…&projects=…&types=…` and the
 * BFF read `window`, `projectIds`, `workItemTypes`. Only `tags` and
 * `states` happened to coincide, so those were the only two filters that
 * ever worked — and the iteration alignment picker was a silent no-op,
 * because `mode` was never read and the window always defaulted to the
 * current sprint. Nothing failed loudly: an unknown query parameter is
 * not an error, it is just ignored.
 *
 * So the names live here, the encoder lives here, and the decoder lives
 * here. The hub uses them for its own URL and for the request; the BFF
 * uses the same decoder on what arrives. Two sides cannot disagree about
 * a spelling they no longer each own.
 */
import { z } from 'zod';
import { boardSnapshotQuerySchema, type BoardSnapshotQuery } from './api.js';
import { boardGroupingSchema } from './board.js';
import { boardFilterSetSchema, EMPTY_BOARD_FILTER_SET } from './filters.js';
import {
  DEFAULT_ITERATION_ALIGNMENT,
  iterationAlignmentSchema,
  type IterationAlignment,
} from './iteration.js';

/**
 * Every query-string key the board query owns. The short spellings are
 * kept because they are the ones already in people's shared links; the
 * BFF's longer ones never worked, so nothing depends on them.
 */
export const BOARD_QUERY_PARAM_KEYS = [
  'mode',
  'start',
  'end',
  'iteration',
  'grouping',
  'projects',
  'teams',
  'types',
  'tags',
  'states',
  'unassigned',
] as const;
export type BoardQueryParamKey = (typeof BOARD_QUERY_PARAM_KEYS)[number];

const setList = (
  params: URLSearchParams,
  key: BoardQueryParamKey,
  values: readonly string[],
): void => {
  if (values.length > 0) params.set(key, values.join(','));
};

const getList = (
  params: URLSearchParams,
  key: BoardQueryParamKey,
): string[] => {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
};

export function encodeBoardQuery(query: BoardSnapshotQuery): URLSearchParams {
  const params = new URLSearchParams();
  const { alignment, grouping, filters } = query;

  params.set('mode', alignment.mode);
  if (alignment.mode === 'date-window') {
    params.set('start', alignment.window.start);
    params.set('end', alignment.window.end);
  } else if (alignment.mode === 'named-iteration') {
    params.set('iteration', alignment.iterationPath);
  }
  if (grouping !== null) params.set('grouping', grouping);

  setList(params, 'projects', filters.projectIds);
  setList(params, 'teams', filters.teamIds);
  setList(params, 'types', filters.workItemTypes);
  setList(params, 'tags', filters.tags);
  setList(params, 'states', filters.states);
  if (filters.unassignedOnly) params.set('unassigned', '1');

  return params;
}

function alignmentCandidate(params: URLSearchParams): unknown {
  const mode = params.get('mode');
  if (mode === 'date-window') {
    return {
      mode,
      window: { start: params.get('start'), end: params.get('end') },
    };
  }
  if (mode === 'named-iteration') {
    return { mode, iterationPath: params.get('iteration') };
  }
  return { mode: mode ?? DEFAULT_ITERATION_ALIGNMENT.mode };
}

function decodeAlignment(params: URLSearchParams): IterationAlignment {
  const mode = params.get('mode');
  const candidate =
    mode === 'date-window'
      ? { mode, window: { start: params.get('start'), end: params.get('end') } }
      : mode === 'named-iteration'
        ? { mode, iterationPath: params.get('iteration') }
        : { mode: mode ?? DEFAULT_ITERATION_ALIGNMENT.mode };

  const parsed = iterationAlignmentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_ITERATION_ALIGNMENT;
}

/**
 * The query as it is spelled in the parameters, BEFORE validation.
 *
 * The two sides share the spelling but not the error policy, and that
 * difference is deliberate. The hub reads its own URL, where a
 * hand-edited or stale link must degrade to a sensible board rather than
 * a blank screen. The BFF reads a request, where a window whose end
 * precedes its start is a caller's mistake and deserves a 400 rather
 * than a silent answer to a question nobody asked.
 */
export function boardQueryCandidate(input: URLSearchParams | string): unknown {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input;
  const grouping = params.get('grouping');
  return {
    alignment: alignmentCandidate(params),
    grouping: grouping === null || grouping === '' ? null : grouping,
    filters: {
      projectIds: getList(params, 'projects'),
      teamIds: getList(params, 'teams'),
      workItemTypes: getList(params, 'types'),
      tags: getList(params, 'tags'),
      states: getList(params, 'states'),
      unassignedOnly: params.get('unassigned') === '1',
    },
  };
}

/** Lenient: for the hub's own URL. Anything malformed falls back. */
export function decodeBoardQuery(
  input: URLSearchParams | string,
): BoardSnapshotQuery {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input;

  const filters = boardFilterSetSchema.safeParse({
    projectIds: getList(params, 'projects'),
    teamIds: getList(params, 'teams'),
    workItemTypes: getList(params, 'types'),
    tags: getList(params, 'tags'),
    states: getList(params, 'states'),
    unassignedOnly: params.get('unassigned') === '1',
  });
  const grouping = boardGroupingSchema.safeParse(params.get('grouping'));

  return boardSnapshotQuerySchema.parse({
    alignment: decodeAlignment(params),
    grouping: grouping.success ? grouping.data : null,
    filters: filters.success ? filters.data : EMPTY_BOARD_FILTER_SET,
  });
}

/**
 * A Fastify query object as URLSearchParams. A repeated key arrives as an
 * array, which `URLSearchParams` would otherwise stringify as "a,b" —
 * harmless here only because the lists are comma-separated anyway, but
 * spelled out so it is a decision rather than a coincidence.
 */
export function boardQueryParamsFrom(raw: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (typeof raw !== 'object' || raw === null) return params;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const flat = Array.isArray(value) ? value.join(',') : value;
    if (typeof flat === 'string' || typeof flat === 'number') {
      params.set(key, String(flat));
    }
  }
  return params;
}

/** Merges the board query into an existing query string, in place. */
export function mergeBoardQuery(
  existing: URLSearchParams,
  query: BoardSnapshotQuery,
): URLSearchParams {
  const next = new URLSearchParams(existing);
  for (const key of BOARD_QUERY_PARAM_KEYS) next.delete(key);
  for (const [key, value] of encodeBoardQuery(query)) next.append(key, value);
  return next;
}

/** The query a board load runs with when nothing is asked for. */
export const DEFAULT_BOARD_SNAPSHOT_QUERY: BoardSnapshotQuery = {
  alignment: DEFAULT_ITERATION_ALIGNMENT,
  grouping: null,
  filters: EMPTY_BOARD_FILTER_SET,
};

/** Re-exported so callers do not have to reach into two modules. */
export const boardQuerySchema = boardSnapshotQuerySchema;
export type { BoardSnapshotQuery };

/** Narrow helper for tests and callers that hold only a filter set. */
export const boardQueryParamKeySchema = z.enum(BOARD_QUERY_PARAM_KEYS);
