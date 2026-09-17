import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFilters } from './useFilters';

function setLocation(search: string): void {
  window.history.replaceState(null, '', `/board${search}`);
}

describe('useFilters', () => {
  beforeEach(() => {
    setLocation('');
  });

  it('starts unfiltered on a bare URL', () => {
    const { result } = renderHook(() => useFilters());

    expect(result.current.filters.projectIds).toEqual([]);
    expect(result.current.alignment).toEqual({ mode: 'each-team-current' });
    expect(result.current.grouping).toBeNull();
    expect(result.current.isFiltered).toBe(false);
  });

  it('reads the filter set out of the URL, so a link survives a refresh', () => {
    setLocation(
      '?projects=Delivery,Data%20and%20AI&types=Bug&tags=risk' +
        '&states=Active&unassigned=1&grouping=team' +
        '&mode=named-iteration&iteration=Delivery%5CSprint%2024',
    );

    const { result } = renderHook(() => useFilters());

    expect(result.current.filters).toEqual({
      projectIds: ['Delivery', 'Data and AI'],
      teamIds: [],
      workItemTypes: ['Bug'],
      tags: ['risk'],
      states: ['Active'],
      unassignedOnly: true,
    });
    expect(result.current.grouping).toBe('team');
    expect(result.current.alignment).toEqual({
      mode: 'named-iteration',
      iterationPath: 'Delivery\\Sprint 24',
    });
    expect(result.current.activeFilterCount).toBe(5);
  });

  it('writes a toggled facet back to the URL', () => {
    const { result } = renderHook(() => useFilters());

    act(() => {
      result.current.toggleFilterValue('workItemTypes', 'Bug');
    });

    expect(result.current.filters.workItemTypes).toEqual(['Bug']);
    expect(new URLSearchParams(window.location.search).get('types')).toBe(
      'Bug',
    );

    act(() => {
      result.current.toggleFilterValue('workItemTypes', 'Bug');
    });

    expect(result.current.filters.workItemTypes).toEqual([]);
    expect(new URLSearchParams(window.location.search).has('types')).toBe(
      false,
    );
  });

  it('keeps unrelated query parameters', () => {
    setLocation('?contributionId=hub&types=Bug');
    const { result } = renderHook(() => useFilters());

    act(() => {
      result.current.clearFilters();
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('contributionId')).toBe('hub');
    expect(params.has('types')).toBe(false);
  });

  it('round-trips the date window', () => {
    const { result } = renderHook(() => useFilters());

    act(() => {
      result.current.setAlignment({
        mode: 'date-window',
        window: { start: '2026-09-01', end: '2026-09-30' },
      });
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('mode')).toBe('date-window');
    expect(params.get('start')).toBe('2026-09-01');
    expect(params.get('end')).toBe('2026-09-30');
    expect(result.current.shareUrl).toContain('mode=date-window');
  });

  it('falls back to defaults for a hand-edited URL', () => {
    setLocation('?mode=nonsense&grouping=sideways&unassigned=maybe');
    const { result } = renderHook(() => useFilters());

    expect(result.current.alignment).toEqual({ mode: 'each-team-current' });
    expect(result.current.grouping).toBeNull();
    expect(result.current.filters.unassignedOnly).toBe(false);
  });

  it('seeds from the caller only when the URL carries no query', () => {
    const { result } = renderHook(() =>
      useFilters({ initial: { grouping: 'team' } }),
    );
    expect(result.current.grouping).toBe('team');

    setLocation('?grouping=person');
    const second = renderHook(() =>
      useFilters({ initial: { grouping: 'team' } }),
    );
    expect(second.result.current.grouping).toBe('person');
  });

  it('follows the back button', () => {
    const { result } = renderHook(() => useFilters({ historyMode: 'push' }));

    act(() => {
      result.current.toggleFilterValue('tags', 'risk');
    });
    expect(result.current.filters.tags).toEqual(['risk']);

    act(() => {
      setLocation('');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.filters.tags).toEqual([]);
  });
});
