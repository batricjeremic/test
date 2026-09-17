/**
 * One encoding for the board query, used twice: on the wire to the BFF
 * and in the hub's own URL, so a filtered board can be shared as a link
 * and survives a refresh.
 */
import {
  boardFilterSetSchema,
  boardGroupingSchema,
  DEFAULT_ITERATION_ALIGNMENT,
  EMPTY_BOARD_FILTER_SET,
  iterationAlignmentSchema,
} from '@eg/shared';
import type {
  BoardFilterSet,
  BoardGrouping,
  IterationAlignment,
} from '@eg/shared';

/** Everything the board load is parameterised by. */
export type BoardQuery = {
  /** Iteration window: which sprint "this sprint" means. */
  alignment: IterationAlignment;
  /** Null falls back to the board definition's `defaultGrouping`. */
  grouping: BoardGrouping | null;
  filters: BoardFilterSet;
};

export const DEFAULT_BOARD_QUERY: BoardQuery = {
  alignment: DEFAULT_ITERATION_ALIGNMENT,
  grouping: null,
  filters: EMPTY_BOARD_FILTER_SET,
};

/** Query-string keys this module owns. Anything else is left untouched. */
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

export function encodeBoardQuery(query: BoardQuery): URLSearchParams {
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

/**
 * Reads a board query out of a query string. Anything malformed falls
 * back to its default rather than throwing: a hand-edited URL must not
 * be able to break the hub.
 */
export function decodeBoardQuery(input: URLSearchParams | string): BoardQuery {
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

  return {
    alignment: decodeAlignment(params),
    grouping: grouping.success ? grouping.data : null,
    filters: filters.success ? filters.data : EMPTY_BOARD_FILTER_SET,
  };
}

/** Merges the board query into an existing query string, in place. */
export function mergeBoardQuery(
  existing: URLSearchParams,
  query: BoardQuery,
): URLSearchParams {
  const next = new URLSearchParams(existing);
  for (const key of BOARD_QUERY_PARAM_KEYS) next.delete(key);
  for (const [key, value] of encodeBoardQuery(query)) next.append(key, value);
  return next;
}

function decodeAlignment(params: URLSearchParams): IterationAlignment {
  const mode = params.get('mode');
  const candidate =
    mode === 'date-window'
      ? {
          mode,
          window: { start: params.get('start'), end: params.get('end') },
        }
      : mode === 'named-iteration'
        ? { mode, iterationPath: params.get('iteration') }
        : { mode: mode ?? DEFAULT_ITERATION_ALIGNMENT.mode };

  const parsed = iterationAlignmentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_ITERATION_ALIGNMENT;
}

function setList(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  if (values.length > 0) params.set(key, values.join(','));
}

function getList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}
