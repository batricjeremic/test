import { describe, expect, it } from 'vitest';
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard } from '@eg/shared';
import { buildAreaPathIndex } from './area-paths.js';
import {
  buildBoardCard,
  dedupeCardCandidates,
  isGroupDescriptor,
  isUnassignedCard,
  personDescriptorOf,
  remainingWorkHours,
  sortBoardCards,
  toIdentityRef,
} from './cards.js';
import { buildMappingIndex } from './mapping.js';
import {
  BOARD_ID,
  makeCanonicalColumns,
  makeMapping,
  makeTeam,
  makeWorkItem,
} from './test-support.js';

const dev = makeTeam({
  teamId: 'team-dev',
  teamName: 'Dev',
  projectId: 'Delivery',
  adoBoardId: 'ado-dev',
  columns: [
    { name: 'To do', id: 'dev-todo' },
    { name: 'Doing', id: 'dev-doing' },
    { name: 'In review', id: 'dev-review' },
  ],
});

const web = makeTeam({
  teamId: 'team-web',
  teamName: 'Web',
  projectId: 'Delivery',
  adoBoardId: 'ado-web',
  columns: [{ name: 'Active', id: 'web-active' }],
});

const index = buildMappingIndex({
  boardId: BOARD_ID,
  canonicalColumns: makeCanonicalColumns(),
  mappings: [
    makeMapping('team-dev', 'dev-todo', 'col-todo'),
    makeMapping('team-dev', 'dev-doing', 'col-doing', 'Active'),
    makeMapping('team-web', 'web-active', 'col-doing'),
  ],
  teams: [dev, web],
});

const areaPaths = buildAreaPathIndex([
  {
    projectId: 'Delivery',
    teamId: 'team-dev',
    areaPaths: [{ value: 'Delivery', includeChildren: true }],
  },
  {
    projectId: 'Delivery',
    teamId: 'team-web',
    areaPaths: [{ value: 'Delivery\\Web', includeChildren: true }],
  },
]);

const options = {
  index,
  areaPaths,
  team: dev,
  iterationId: 'it-dev-24',
};

describe('buildBoardCard', () => {
  it('maps every field of the spec card block', () => {
    const candidate = buildBoardCard(
      makeWorkItem({
        id: 4211,
        rev: 9,
        title: 'Wire the hub to the BFF',
        type: 'User Story',
        state: 'Active',
        areaPath: 'Delivery\\Core',
        assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
        remainingWork: 4.5,
        tags: ['hub', 'risk'],
        column: 'Doing',
        adoBoardId: 'ado-dev',
      }),
      options,
    );
    expect(candidate?.card).toEqual<BoardCard>({
      workItemId: 4211,
      project: 'Delivery',
      teamId: 'team-dev',
      iterationId: 'it-dev-24',
      title: 'Wire the hub to the BFF',
      type: 'User Story',
      assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
      state: 'Active',
      sourceColumn: 'Doing',
      canonicalColumnId: 'col-doing',
      remainingWork: 4.5,
      tags: ['hub', 'risk'],
      rev: 9,
    });
    expect(candidate?.owned).toBe(true);
  });

  it('resolves the owning team from the area path, not the fetching team', () => {
    const candidate = buildBoardCard(
      makeWorkItem({
        id: 7,
        areaPath: 'Delivery\\Web\\Checkout',
        column: 'Active',
        adoBoardId: 'ado-web',
      }),
      options,
    );
    expect(candidate?.card.teamId).toBe('team-web');
    // The column came from the owning team's own WEF field.
    expect(candidate?.card.canonicalColumnId).toBe('col-doing');
    expect(candidate?.owned).toBe(true);
  });

  it('keeps the fetching team when no area path claims the card', () => {
    const candidate = buildBoardCard(
      makeWorkItem({
        id: 8,
        areaPath: 'Nowhere\\At all',
        column: 'To do',
        adoBoardId: 'ado-dev',
      }),
      options,
    );
    expect(candidate?.card.teamId).toBe('team-dev');
    expect(candidate?.owned).toBe(false);
  });

  it('puts a card with no mapping row in the Unmapped lane, column named', () => {
    const candidate = buildBoardCard(
      makeWorkItem({ id: 9, column: 'In review', adoBoardId: 'ado-dev' }),
      { ...options, areaPaths: null },
    );
    expect(candidate?.card.canonicalColumnId).toBe(UNMAPPED_COLUMN_ID);
    expect(candidate?.card.sourceColumn).toBe('In review');
  });

  it('treats a work item with no board column as unmapped, not as column one', () => {
    const candidate = buildBoardCard(makeWorkItem({ id: 10 }), options);
    expect(candidate?.card.sourceColumn).toBe('');
    expect(candidate?.card.canonicalColumnId).toBe(UNMAPPED_COLUMN_ID);
  });

  it('defaults absent text fields rather than dropping the card', () => {
    const candidate = buildBoardCard({ id: 11, rev: 0, fields: {} }, options);
    expect(candidate?.card).toMatchObject({
      title: '',
      type: 'Unknown',
      state: '',
      assignedTo: null,
      remainingWork: null,
      tags: [],
      rev: 0,
    });
  });

  it('refuses a work item that cannot make a valid card', () => {
    expect(buildBoardCard({ id: 0, rev: 1, fields: {} }, options)).toBeNull();
    expect(buildBoardCard({ id: -3, rev: 1, fields: {} }, options)).toBeNull();
  });

  it('falls back to the identity id when a descriptor is missing', () => {
    const candidate = buildBoardCard(
      makeWorkItem({
        id: 12,
        extraFields: {
          'System.AssignedTo': { id: 'guid-1', displayName: 'X' },
        },
      }),
      options,
    );
    expect(candidate?.card.assignedTo).toEqual({
      descriptor: 'guid-1',
      displayName: 'X',
    });
  });

  it('reads an unusable identity as unassigned', () => {
    const candidate = buildBoardCard(
      makeWorkItem({ id: 13, extraFields: { 'System.AssignedTo': 42 } }),
      options,
    );
    expect(candidate?.card.assignedTo).toBeNull();
  });
});

describe('assignment helpers', () => {
  it.each([
    ['vssgp.Uy0xLTk', true],
    ['aadgp.Uy0xLTk', true],
    ['AADGP.UPPER', true],
    ['aad.ana', false],
    ['msa.someone', false],
  ])('%s is a group: %s', (descriptor, expected) => {
    expect(isGroupDescriptor(descriptor)).toBe(expected);
  });

  const card = (assignedTo: BoardCard['assignedTo']): BoardCard => ({
    workItemId: 1,
    project: 'Delivery',
    teamId: 'team-dev',
    iterationId: 'it-1',
    title: '',
    type: 'Task',
    assignedTo,
    state: 'Active',
    sourceColumn: 'Doing',
    canonicalColumnId: 'col-doing',
    remainingWork: null,
    tags: [],
    rev: 1,
  });

  it('treats group-assigned and unassigned cards alike', () => {
    expect(isUnassignedCard(card(null))).toBe(true);
    expect(
      isUnassignedCard(card({ descriptor: 'vssgp.X', displayName: 'Team' })),
    ).toBe(true);
    expect(
      isUnassignedCard(card({ descriptor: 'aad.ana', displayName: 'Ana' })),
    ).toBe(false);
    expect(
      personDescriptorOf(card({ descriptor: 'vssgp.X', displayName: '' })),
    ).toBeNull();
    expect(personDescriptorOf(card(null))).toBeNull();
    expect(
      personDescriptorOf(card({ descriptor: 'aad.ana', displayName: 'Ana' })),
    ).toBe('aad.ana');
  });

  it('reads identities defensively', () => {
    expect(toIdentityRef(null)).toBeNull();
    expect(toIdentityRef({ displayName: 'No descriptor' })).toBeNull();
    expect(toIdentityRef({ descriptor: 'aad.ana' })).toEqual({
      descriptor: 'aad.ana',
      displayName: '',
    });
  });

  it('reads remaining work, floor-clamping nonsense', () => {
    expect(remainingWorkHours(card(null))).toBeNull();
    expect(remainingWorkHours({ ...card(null), remainingWork: 3 })).toBe(3);
    expect(remainingWorkHours({ ...card(null), remainingWork: -2 })).toBe(0);
    expect(
      remainingWorkHours({ ...card(null), remainingWork: Number.NaN }),
    ).toBeNull();
  });
});

describe('dedupeCardCandidates', () => {
  const candidate = (
    workItemId: number,
    teamId: string,
    owned: boolean,
    iterationId = 'it-1',
  ) => ({
    owned,
    card: {
      workItemId,
      project: 'Delivery',
      teamId,
      iterationId,
      title: '',
      type: 'Task',
      assignedTo: null,
      state: 'Active',
      sourceColumn: 'Doing',
      canonicalColumnId: 'col-doing',
      remainingWork: null,
      tags: [],
      rev: 1,
    } satisfies BoardCard,
  });

  it('keeps the copy whose team owns the card', () => {
    const cards = dedupeCardCandidates([
      candidate(1, 'team-dev', false),
      candidate(1, 'team-web', true),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.teamId).toBe('team-web');
  });

  it('is order independent', () => {
    const forward = dedupeCardCandidates([
      candidate(1, 'team-web', true),
      candidate(1, 'team-dev', false),
    ]);
    expect(forward[0]?.teamId).toBe('team-web');
  });

  it('breaks a tie on team then iteration id', () => {
    const cards = dedupeCardCandidates([
      candidate(1, 'team-web', false, 'it-2'),
      candidate(1, 'team-dev', false, 'it-9'),
      candidate(1, 'team-dev', false, 'it-3'),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ teamId: 'team-dev', iterationId: 'it-3' });
  });
});

describe('sortBoardCards', () => {
  it('orders by column, project, team then work item id', () => {
    const base = {
      project: 'Delivery',
      teamId: 'team-dev',
      iterationId: 'it-1',
      title: '',
      type: 'Task',
      assignedTo: null,
      state: 'Active',
      sourceColumn: '',
      remainingWork: null,
      tags: [],
      rev: 1,
    };
    const cards: BoardCard[] = [
      { ...base, workItemId: 3, canonicalColumnId: UNMAPPED_COLUMN_ID },
      { ...base, workItemId: 2, canonicalColumnId: 'col-doing' },
      { ...base, workItemId: 1, canonicalColumnId: 'col-doing' },
      {
        ...base,
        workItemId: 4,
        canonicalColumnId: 'col-todo',
        project: 'Data',
        teamId: 'team-web',
      },
    ];
    expect(sortBoardCards(cards, index).map((card) => card.workItemId)).toEqual(
      [4, 1, 2, 3],
    );
    // Sorting the sorted list changes nothing: the order is total.
    expect(
      sortBoardCards(sortBoardCards(cards, index), index).map(
        (card) => card.workItemId,
      ),
    ).toEqual([4, 1, 2, 3]);
  });
});
