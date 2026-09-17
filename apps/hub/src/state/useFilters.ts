/**
 * `useFilters` — the composable filter set, kept in the URL.
 *
 * A filtered board is a link somebody can paste into a chat, and it
 * survives a refresh, so the URL is the state rather than a mirror of it.
 * The iteration window and the grouping live there too, because "the
 * board I am looking at" is all three.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_BOARD_FILTER_SET } from '@eg/shared';
import type {
  BoardFilterSet,
  BoardGrouping,
  IterationAlignment,
} from '@eg/shared';
import {
  BOARD_QUERY_PARAM_KEYS,
  DEFAULT_BOARD_QUERY,
  decodeBoardQuery,
  mergeBoardQuery,
} from '../api';
import type { BoardQuery } from '../api';

/** Filter facets that hold a list of values. */
export type ListFilterKey = Extract<
  keyof BoardFilterSet,
  'projectIds' | 'teamIds' | 'workItemTypes' | 'tags' | 'states'
>;

export const LIST_FILTER_KEYS: readonly ListFilterKey[] = [
  'projectIds',
  'teamIds',
  'workItemTypes',
  'tags',
  'states',
];

export type UseFiltersOptions = {
  /**
   * `replace` (the default) keeps the back button useful: toggling ten
   * filters should not mean ten presses to leave the board.
   */
  historyMode?: 'replace' | 'push';
  /** Used only when the URL carries no board query at all. */
  initial?: Partial<BoardQuery>;
};

export type UseFiltersResult = {
  filters: BoardFilterSet;
  /** The iteration window: `useBoard`'s second argument. */
  alignment: IterationAlignment;
  /** Null means "use the board definition's default grouping". */
  grouping: BoardGrouping | null;
  /** All three together, for passing straight to the client. */
  query: BoardQuery;
  setFilters(
    next: BoardFilterSet | ((previous: BoardFilterSet) => BoardFilterSet),
  ): void;
  /** Merges a partial filter set, leaving the other facets alone. */
  patchFilters(patch: Partial<BoardFilterSet>): void;
  /** Adds or removes one value from a list facet. */
  toggleFilterValue(key: ListFilterKey, value: string): void;
  setUnassignedOnly(unassignedOnly: boolean): void;
  clearFilters(): void;
  setAlignment(alignment: IterationAlignment): void;
  setGrouping(grouping: BoardGrouping | null): void;
  /** True when any facet is narrowing the board. */
  isFiltered: boolean;
  /** Facet count, for the "Filters (3)" badge. */
  activeFilterCount: number;
  /** The current board as a shareable absolute URL. */
  shareUrl: string;
};

export function useFilters(options: UseFiltersOptions = {}): UseFiltersResult {
  const { historyMode = 'replace', initial } = options;

  const [query, setQuery] = useState<BoardQuery>(() =>
    readQueryFromLocation(initial),
  );

  useEffect(() => {
    const onPopState = (): void => {
      setQuery(readQueryFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  // The URL follows the state rather than being written from inside an
  // updater, so a double-invoked render in StrictMode cannot push twice.
  const isFirstSync = useRef(true);
  useEffect(() => {
    if (isFirstSync.current) {
      isFirstSync.current = false;
      if (historyMode === 'push') return;
    }
    writeQueryToLocation(query, historyMode);
  }, [query, historyMode]);

  const commit = useCallback((next: BoardQuery): void => {
    setQuery(next);
  }, []);

  const setFilters = useCallback<UseFiltersResult['setFilters']>((next) => {
    setQuery((previous) => ({
      ...previous,
      filters: typeof next === 'function' ? next(previous.filters) : next,
    }));
  }, []);

  const patchFilters = useCallback(
    (patch: Partial<BoardFilterSet>) => {
      setFilters((previous) => ({ ...previous, ...patch }));
    },
    [setFilters],
  );

  const toggleFilterValue = useCallback(
    (key: ListFilterKey, value: string) => {
      setFilters((previous) => {
        const current = previous[key];
        const next = current.includes(value)
          ? current.filter((entry) => entry !== value)
          : [...current, value];
        return { ...previous, [key]: next };
      });
    },
    [setFilters],
  );

  const setUnassignedOnly = useCallback(
    (unassignedOnly: boolean) => {
      patchFilters({ unassignedOnly });
    },
    [patchFilters],
  );

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_BOARD_FILTER_SET);
  }, [setFilters]);

  const setAlignment = useCallback(
    (alignment: IterationAlignment) => {
      commit({ ...query, alignment });
    },
    [commit, query],
  );

  const setGrouping = useCallback(
    (grouping: BoardGrouping | null) => {
      commit({ ...query, grouping });
    },
    [commit, query],
  );

  const activeFilterCount = useMemo(
    () => countActiveFilters(query.filters),
    [query.filters],
  );

  const shareUrl = useMemo(() => buildShareUrl(query), [query]);

  return {
    filters: query.filters,
    alignment: query.alignment,
    grouping: query.grouping,
    query,
    setFilters,
    patchFilters,
    toggleFilterValue,
    setUnassignedOnly,
    clearFilters,
    setAlignment,
    setGrouping,
    isFiltered: activeFilterCount > 0,
    activeFilterCount,
    shareUrl,
  };
}

/** Counts the facets that are narrowing the board, for a badge. */
export function countActiveFilters(filters: BoardFilterSet): number {
  let count = 0;
  for (const key of LIST_FILTER_KEYS) {
    if (filters[key].length > 0) count += 1;
  }
  if (filters.unassignedOnly) count += 1;
  return count;
}

function readQueryFromLocation(initial?: Partial<BoardQuery>): BoardQuery {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_BOARD_QUERY, ...initial };
  }
  const params = new URLSearchParams(window.location.search);
  const hasQuery = BOARD_QUERY_PARAM_KEYS.some((key) => params.has(key));
  if (!hasQuery && initial) {
    return { ...DEFAULT_BOARD_QUERY, ...initial };
  }
  return decodeBoardQuery(params);
}

function writeQueryToLocation(
  query: BoardQuery,
  historyMode: 'replace' | 'push',
): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.search = mergeBoardQuery(
      new URLSearchParams(window.location.search),
      query,
    ).toString();
    const history = window.history;
    if (historyMode === 'push') {
      history.pushState(history.state, '', url);
    } else {
      history.replaceState(history.state, '', url);
    }
  } catch {
    // A sandboxed frame can refuse history writes. The board still works;
    // only the shareable URL is lost.
  }
}

function buildShareUrl(query: BoardQuery): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.search = mergeBoardQuery(
    new URLSearchParams(window.location.search),
    query,
  ).toString();
  return url.toString();
}
