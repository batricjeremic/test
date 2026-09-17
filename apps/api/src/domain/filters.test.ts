import { describe, expect, it } from 'vitest';
import { EMPTY_BOARD_FILTER_SET } from '@eg/shared';
import type { BoardCard, BoardFilterSet } from '@eg/shared';
import {
  applyBoardFilters,
  compileBoardFilters,
  matchesBoardFilters,
  matchesCompiledFilters,
} from './filters.js';

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    workItemId: 1,
    project: 'Delivery',
    teamId: 'team-dev',
    iterationId: 'it-1',
    title: 'Card',
    type: 'User Story',
    assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
    state: 'Active',
    sourceColumn: 'Doing',
    canonicalColumnId: 'col-doing',
    remainingWork: 3,
    tags: ['hub'],
    rev: 1,
    ...overrides,
  };
}

const filters = (overrides: Partial<BoardFilterSet>): BoardFilterSet => ({
  ...EMPTY_BOARD_FILTER_SET,
  ...overrides,
});

const cards: BoardCard[] = [
  card({ workItemId: 1 }),
  card({
    workItemId: 2,
    project: 'Data',
    teamId: 'team-data',
    type: 'Bug',
    state: 'New',
    tags: ['risk', 'hub'],
  }),
  card({
    workItemId: 3,
    type: 'Task',
    state: 'Closed',
    tags: [],
    assignedTo: null,
  }),
  card({
    workItemId: 4,
    type: 'Task',
    assignedTo: { descriptor: 'vssgp.Delivery', displayName: 'Delivery team' },
  }),
];

const ids = (result: readonly BoardCard[]): number[] =>
  result.map((entry) => entry.workItemId);

describe('applyBoardFilters', () => {
  it('lets everything through when nothing is selected', () => {
    expect(ids(applyBoardFilters(cards, EMPTY_BOARD_FILTER_SET))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it.each<[string, Partial<BoardFilterSet>, number[]]>([
    ['project', { projectIds: ['Data'] }, [2]],
    ['team', { teamIds: ['team-dev'] }, [1, 3, 4]],
    ['work item type', { workItemTypes: ['Task'] }, [3, 4]],
    ['tag', { tags: ['risk'] }, [2]],
    ['state', { states: ['Closed'] }, [3]],
    ['unassigned', { unassignedOnly: true }, [3, 4]],
  ])('filters by %s', (_facet, selection, expected) => {
    expect(ids(applyBoardFilters(cards, filters(selection)))).toEqual(expected);
  });

  it('treats values within one facet as alternatives', () => {
    expect(
      ids(
        applyBoardFilters(cards, filters({ workItemTypes: ['Task', 'Bug'] })),
      ),
    ).toEqual([2, 3, 4]);
  });

  it('composes facets: every one of them has to hold', () => {
    expect(
      ids(
        applyBoardFilters(
          cards,
          filters({ teamIds: ['team-dev'], workItemTypes: ['Task'] }),
        ),
      ),
    ).toEqual([3, 4]);
    expect(
      ids(
        applyBoardFilters(
          cards,
          filters({ projectIds: ['Data'], workItemTypes: ['Task'] }),
        ),
      ),
    ).toEqual([]);
  });

  it('matches a card carrying any one of the selected tags', () => {
    expect(
      ids(applyBoardFilters(cards, filters({ tags: ['hub', 'nothing'] }))),
    ).toEqual([1, 2, 4]);
  });

  it('ignores case on the free-text facets', () => {
    expect(
      ids(
        applyBoardFilters(
          cards,
          filters({ workItemTypes: ['task'], states: ['CLOSED'], tags: [] }),
        ),
      ),
    ).toEqual([3]);
    expect(ids(applyBoardFilters(cards, filters({ tags: ['RISK'] })))).toEqual([
      2,
    ]);
  });

  it('matches ids exactly, because they are ids', () => {
    expect(
      ids(applyBoardFilters(cards, filters({ projectIds: ['data'] }))),
    ).toEqual([]);
  });

  it('counts a group-assigned card as unassigned', () => {
    expect(
      ids(applyBoardFilters(cards, filters({ unassignedOnly: true }))),
    ).toContain(4);
  });

  it('preserves the order it was given', () => {
    const reversed = [...cards].reverse();
    expect(ids(applyBoardFilters(reversed, EMPTY_BOARD_FILTER_SET))).toEqual([
      4, 3, 2, 1,
    ]);
  });

  it('does not mutate the input', () => {
    const snapshot = JSON.stringify(cards);
    applyBoardFilters(cards, filters({ states: ['Active'] }));
    expect(JSON.stringify(cards)).toBe(snapshot);
  });
});

describe('matchesBoardFilters', () => {
  it('is the single-card form of the same rules', () => {
    const selection = filters({ states: ['active'] });
    const compiled = compileBoardFilters(selection);
    for (const entry of cards) {
      expect(matchesBoardFilters(entry, selection)).toBe(
        matchesCompiledFilters(entry, compiled),
      );
    }
  });
});
