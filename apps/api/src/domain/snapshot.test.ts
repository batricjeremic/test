import { describe, expect, it } from 'vitest';
import {
  boardSnapshotQuerySchema,
  boardSnapshotSchema,
  UNASSIGNED_LANE_ID,
  UNMAPPED_COLUMN_ID,
} from '@eg/shared';
import type { BoardCard, BoardSnapshotQueryInput } from '@eg/shared';
import type { TeamAreaPaths } from './area-paths.js';
import { personLaneId, teamLaneId } from './swimlanes.js';
import type { BoardSnapshotInput, TeamSnapshotInput } from './snapshot.js';
import {
  assembleBoardSnapshot,
  buildSnapshotParts,
  unmappedCardCount,
} from './snapshot.js';
import {
  BOARD_ID,
  CACHE_MISS,
  LIVE_REALTIME,
  fixedClock,
  makeCanonicalColumns,
  makeCapacity,
  makeDefinition,
  makeIteration,
  makeMapping,
  makePermissions,
  makeTeam,
  makeWorkItem,
} from './test-support.js';

const NOW = '2026-09-17T09:00:00.000Z';
const clock = fixedClock(NOW);

const dev = makeTeam({
  teamId: 'team-dev',
  teamName: 'Dev',
  projectId: 'Delivery',
  projectName: 'Delivery',
  adoBoardId: 'ado-dev',
  columns: [
    { name: 'To do', id: 'dev-todo' },
    { name: 'Doing', id: 'dev-doing' },
    { name: 'In review', id: 'dev-review' },
    { name: 'Done', id: 'dev-done' },
  ],
});

const data = makeTeam({
  teamId: 'team-data',
  teamName: 'Data and AI',
  projectId: 'Data',
  projectName: 'Data',
  adoBoardId: 'ado-data',
  columns: [
    { name: 'New', id: 'data-new' },
    { name: 'Active', id: 'data-active' },
    { name: 'Closed', id: 'data-closed' },
  ],
});

const devArea: TeamAreaPaths = {
  projectId: 'Delivery',
  teamId: 'team-dev',
  areaPaths: [{ value: 'Delivery', includeChildren: true }],
};

const dataArea: TeamAreaPaths = {
  projectId: 'Data',
  teamId: 'team-data',
  areaPaths: [{ value: 'Data', includeChildren: true }],
};

/** Mon 14 to Fri 25 September: ten working days, today is day four. */
const devSprint = makeIteration({
  id: 'it-dev-24',
  name: 'Sprint 24',
  path: 'Delivery\\Sprint 24',
  start: '2026-09-14T00:00:00Z',
  finish: '2026-09-25T00:00:00Z',
  timeFrame: 'current',
});

/** Mon 7 to Fri 18 September: a different window, on purpose. */
const dataSprint = makeIteration({
  id: 'it-data-12',
  name: 'Iteration 12',
  path: 'Data\\Iteration 12',
  start: '2026-09-07T00:00:00Z',
  finish: '2026-09-18T00:00:00Z',
  timeFrame: 'current',
});

const ana = { descriptor: 'aad.ana', displayName: 'Ana Ilic' };
const zoran = { descriptor: 'aad.zoran', displayName: 'Zoran Petrovic' };

function devTeamInput(): TeamSnapshotInput {
  return {
    team: dev,
    areaPaths: devArea,
    iterations: [devSprint],
    workItems: [
      {
        iterationId: 'it-dev-24',
        workItems: [
          makeWorkItem({
            id: 1001,
            rev: 7,
            title: 'Wire the hub to the BFF',
            areaPath: 'Delivery\\Core',
            assignedTo: ana,
            remainingWork: 4,
            column: 'Doing',
            adoBoardId: 'ado-dev',
            tags: ['hub'],
          }),
          makeWorkItem({
            id: 1002,
            areaPath: 'Delivery\\Core',
            assignedTo: ana,
            column: 'In review',
            adoBoardId: 'ado-dev',
          }),
          makeWorkItem({
            id: 1003,
            areaPath: 'Delivery\\Core',
            remainingWork: 2,
            column: 'To do',
            adoBoardId: 'ado-dev',
            type: 'Bug',
          }),
          makeWorkItem({
            id: 1004,
            areaPath: 'Delivery\\Core',
            assignedTo: { descriptor: 'vssgp.Delivery', displayName: 'Del' },
            remainingWork: 1,
            column: 'Doing',
            adoBoardId: 'ado-dev',
          }),
        ],
      },
    ],
    capacity: [
      {
        iterationId: 'it-dev-24',
        capacities: [
          makeCapacity({ ...ana, capacityPerDay: 4 }),
          makeCapacity({ ...zoran, capacityPerDay: 6 }),
        ],
        teamDaysOff: null,
      },
    ],
  };
}

function dataTeamInput(): TeamSnapshotInput {
  return {
    team: data,
    areaPaths: dataArea,
    iterations: [dataSprint],
    workItems: [
      {
        iterationId: 'it-data-12',
        workItems: [
          makeWorkItem({
            id: 2001,
            areaPath: 'Data\\Models',
            assignedTo: ana,
            remainingWork: 3,
            column: 'Active',
            adoBoardId: 'ado-data',
          }),
          makeWorkItem({
            id: 2002,
            areaPath: 'Data\\Models',
            assignedTo: zoran,
            remainingWork: 5,
            column: 'Closed',
            adoBoardId: 'ado-data',
          }),
        ],
      },
    ],
    capacity: [
      {
        iterationId: 'it-data-12',
        capacities: [makeCapacity({ ...ana, capacityPerDay: 2 })],
        teamDaysOff: null,
      },
    ],
  };
}

function makeInput(
  overrides: Partial<BoardSnapshotInput> = {},
  query: BoardSnapshotQueryInput = {},
): BoardSnapshotInput {
  return {
    definition: makeDefinition(),
    query: boardSnapshotQuerySchema.parse(query),
    canonicalColumns: makeCanonicalColumns(),
    mappings: [
      makeMapping('team-dev', 'dev-todo', 'col-todo'),
      makeMapping('team-dev', 'dev-doing', 'col-doing', 'Active'),
      makeMapping('team-dev', 'dev-done', 'col-done', 'Closed'),
      makeMapping('team-data', 'data-new', 'col-todo'),
      makeMapping('team-data', 'data-active', 'col-doing', 'Active'),
    ],
    teams: [devTeamInput(), dataTeamInput()],
    permissions: makePermissions(),
    cache: CACHE_MISS,
    realtime: LIVE_REALTIME,
    traceId: 'trace-1',
    clock,
    ...overrides,
  };
}

const ids = (cards: readonly BoardCard[]): number[] =>
  cards.map((card) => card.workItemId);

describe('assembleBoardSnapshot', () => {
  it('returns a snapshot the shared schema accepts', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    expect(() => boardSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      boardId: BOARD_ID,
      boardName: 'Delivery — all divisions',
      orgId: 'org-expertgroup',
      generatedAt: NOW,
      traceId: 'trace-1',
      grouping: 'person',
      cache: CACHE_MISS,
      realtime: LIVE_REALTIME,
      hiddenCardCount: 0,
    });
  });

  it('merges every team’s iteration work items into one card set', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    expect(ids(snapshot.cards)).toEqual([1003, 2001, 1001, 1004, 2002, 1002]);
    expect(snapshot.cards[0]).toMatchObject({
      workItemId: 1003,
      canonicalColumnId: 'col-todo',
      project: 'Delivery',
      teamId: 'team-dev',
      iterationId: 'it-dev-24',
      type: 'Bug',
    });
    expect(snapshot.cards[1]).toMatchObject({
      workItemId: 2001,
      canonicalColumnId: 'col-doing',
      project: 'Data',
      teamId: 'team-data',
      iterationId: 'it-data-12',
    });
  });

  it('never guesses an unmapped column, and counts what is stranded', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    const stranded = snapshot.cards.filter(
      (card) => card.canonicalColumnId === UNMAPPED_COLUMN_ID,
    );
    expect(ids(stranded)).toEqual([2002, 1002]);
    expect(unmappedCardCount(snapshot.cards)).toBe(2);
    expect(snapshot.unmappedColumns).toEqual([
      {
        projectId: 'Data',
        teamId: 'team-data',
        teamName: 'Data and AI',
        sourceColumn: 'Closed',
        cardCount: 1,
      },
      {
        projectId: 'Delivery',
        teamId: 'team-dev',
        teamName: 'Dev',
        sourceColumn: 'In review',
        cardCount: 1,
      },
    ]);
  });

  it('describes each team board, with its drop targets and its dates', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    expect(snapshot.teams).toHaveLength(2);
    expect(snapshot.teams[0]).toMatchObject({
      projectId: 'Data',
      teamId: 'team-data',
      backlogLevel: 'Microsoft.RequirementCategory',
      mappedCanonicalColumnIds: ['col-todo', 'col-doing'],
      writable: true,
    });
    expect(snapshot.teams[1]?.mappedCanonicalColumnIds).toEqual([
      'col-todo',
      'col-doing',
      'col-done',
    ]);
    expect(snapshot.teams[1]?.iteration).toMatchObject({
      iterationId: 'it-dev-24',
      iterationName: 'Sprint 24',
      workingDaysTotal: 10,
      workingDaysElapsed: 4,
    });
  });

  it('dims a team whose project the caller cannot write', () => {
    const snapshot = assembleBoardSnapshot(
      makeInput({
        permissions: makePermissions({ writableProjectIds: ['Delivery'] }),
      }),
    );
    expect(snapshot.teams.map((team) => [team.teamId, team.writable])).toEqual([
      ['team-data', false],
      ['team-dev', true],
    ]);
  });

  it('suppresses burndown when the teams are in different windows', () => {
    expect(assembleBoardSnapshot(makeInput()).burndown).toBe(
      'suppressed-mismatched-windows',
    );
  });

  it('allows burndown once every team shares one window', () => {
    const aligned = dataTeamInput();
    const snapshot = assembleBoardSnapshot(
      makeInput({
        teams: [
          devTeamInput(),
          {
            ...aligned,
            iterations: [
              makeIteration({
                id: 'it-data-12',
                name: 'Sprint 24',
                path: 'Data\\Sprint 24',
                start: '2026-09-14T00:00:00Z',
                finish: '2026-09-25T00:00:00Z',
                timeFrame: 'current',
              }),
            ],
          },
        ],
      }),
    );
    expect(snapshot.burndown).toBe('available');
  });
});

describe('grouping', () => {
  it('falls back to the board definition default', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    expect(snapshot.grouping).toBe('person');
    expect(snapshot.swimlanes.map((lane) => lane.id)).toEqual([
      UNASSIGNED_LANE_ID,
      personLaneId('aad.ana'),
      personLaneId('aad.zoran'),
    ]);
    expect(snapshot.swimlanes[0]).toMatchObject({
      order: 0,
      cardCount: 2,
      remainingWorkHours: 3,
    });
    expect(snapshot.swimlanes[1]).toMatchObject({
      label: 'Ana Ilic',
      cardCount: 3,
      remainingWorkHours: 7,
      cardsWithoutRemainingWork: 1,
    });
  });

  it('honours an explicit grouping in the query', () => {
    const snapshot = assembleBoardSnapshot(makeInput({}, { grouping: 'team' }));
    expect(snapshot.grouping).toBe('team');
    expect(snapshot.swimlanes.map((lane) => lane.id)).toEqual([
      teamLaneId('team-data'),
      teamLaneId('team-dev'),
    ]);
    expect(snapshot.swimlanes[1]).toMatchObject({
      label: 'Dev',
      cardCount: 4,
      remainingWorkHours: 7,
    });
  });
});

describe('capacity roll-up in the snapshot', () => {
  it('gives a person on two teams one bar, summed over both windows', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    const anaLoad = snapshot.personLoad.find(
      (load) => load.descriptor === 'aad.ana',
    );
    // Dev: 4h x 10 days. Data and AI: 2h x 10 days over its own window.
    expect(anaLoad).toMatchObject({
      displayName: 'Ana Ilic',
      capacityHours: 60,
      committedHours: 7,
      cardCount: 3,
      cardsWithoutRemainingWork: 1,
      partialCapacity: false,
      outOfScopeTeamCount: 0,
    });
    expect(anaLoad?.perTeam.map((team) => team.teamId)).toEqual([
      'team-data',
      'team-dev',
    ]);
  });

  it('raises partial capacity for a team with no record for that person', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    const zoranLoad = snapshot.personLoad.find(
      (load) => load.descriptor === 'aad.zoran',
    );
    expect(zoranLoad).toMatchObject({
      capacityHours: 60,
      committedHours: 5,
      partialCapacity: true,
    });
    expect(zoranLoad?.perTeam).toHaveLength(2);
  });

  it('counts teams outside the board scope as a footnote', () => {
    const snapshot = assembleBoardSnapshot(
      makeInput({
        memberships: [
          { descriptor: 'aad.ana', teamId: 'team-dev' },
          { descriptor: 'aad.ana', teamId: 'team-research' },
        ],
      }),
    );
    expect(
      snapshot.personLoad.find((load) => load.descriptor === 'aad.ana')
        ?.outOfScopeTeamCount,
    ).toBe(1);
  });

  it('keeps group-assigned work out of every person bar', () => {
    const snapshot = assembleBoardSnapshot(makeInput());
    expect(snapshot.personLoad.map((load) => load.descriptor)).toEqual([
      'aad.ana',
      'aad.zoran',
    ]);
  });
});

describe('filters and visibility', () => {
  it('applies the query filters before anything is counted', () => {
    const snapshot = assembleBoardSnapshot(
      makeInput({}, { filters: { projectIds: ['Delivery'] } }),
    );
    expect(ids(snapshot.cards)).toEqual([1003, 1001, 1004, 1002]);
    expect(snapshot.unmappedColumns).toHaveLength(1);
    expect(snapshot.filters.projectIds).toEqual(['Delivery']);
    expect(
      snapshot.personLoad.find((load) => load.descriptor === 'aad.zoran')
        ?.committedHours,
    ).toBe(0);
  });

  it('trims cards the caller may not see, but still shows the lane', () => {
    const snapshot = assembleBoardSnapshot(
      makeInput({ isCardVisible: (card) => card.project !== 'Data' }),
    );
    expect(ids(snapshot.cards)).toEqual([1003, 1001, 1004, 1002]);
    expect(snapshot.hiddenCardCount).toBe(2);
    const zoranLane = snapshot.swimlanes.find(
      (lane) => lane.personDescriptor === 'aad.zoran',
    );
    expect(zoranLane).toMatchObject({ cardCount: 0, hiddenCardCount: 1 });
    // Trimmed hours never reach the bar.
    expect(
      snapshot.personLoad.find((load) => load.descriptor === 'aad.ana')
        ?.committedHours,
    ).toBe(4);
  });

  it('removes a hidden person entirely and counts the removal', () => {
    const snapshot = assembleBoardSnapshot(
      makeInput({
        overrides: [
          {
            boardId: BOARD_ID,
            descriptor: 'aad.zoran',
            displayName: 'Zoran P.',
            hidden: true,
          },
        ],
      }),
    );
    expect(ids(snapshot.cards)).not.toContain(2002);
    expect(snapshot.hiddenCardCount).toBe(1);
    expect(
      snapshot.swimlanes.some((lane) => lane.personDescriptor === 'aad.zoran'),
    ).toBe(false);
    expect(
      snapshot.personLoad.find((load) => load.descriptor === 'aad.zoran'),
    ).toMatchObject({ hidden: true, displayName: 'Zoran P.' });
  });
});

describe('iteration alignment inside a snapshot', () => {
  it('drops a team with no current sprint, and its work items with it', () => {
    const orphan: TeamSnapshotInput = {
      ...dataTeamInput(),
      iterations: [
        makeIteration({
          id: 'it-data-99',
          start: '2026-11-02T00:00:00Z',
          finish: '2026-11-13T00:00:00Z',
          timeFrame: 'future',
        }),
      ],
    };
    const snapshot = assembleBoardSnapshot(
      makeInput({ teams: [devTeamInput(), orphan] }),
    );
    expect(snapshot.teams.map((team) => team.teamId)).toEqual(['team-dev']);
    expect(ids(snapshot.cards)).toEqual([1003, 1001, 1004, 1002]);
  });

  it('ignores work items fetched for an iteration this window excludes', () => {
    const stale: TeamSnapshotInput = {
      ...devTeamInput(),
      workItems: [
        ...devTeamInput().workItems,
        {
          iterationId: 'it-dev-23',
          workItems: [
            makeWorkItem({
              id: 999,
              areaPath: 'Delivery\\Core',
              column: 'Doing',
              adoBoardId: 'ado-dev',
            }),
          ],
        },
      ],
    };
    const snapshot = assembleBoardSnapshot(makeInput({ teams: [stale] }));
    expect(ids(snapshot.cards)).not.toContain(999);
  });

  it('carries both iterations of a date window, card by card', () => {
    const twoSprints: TeamSnapshotInput = {
      ...devTeamInput(),
      iterations: [
        devSprint,
        makeIteration({
          id: 'it-dev-25',
          name: 'Sprint 25',
          path: 'Delivery\\Sprint 25',
          start: '2026-09-28T00:00:00Z',
          finish: '2026-10-09T00:00:00Z',
          timeFrame: 'future',
        }),
      ],
      workItems: [
        ...devTeamInput().workItems,
        {
          iterationId: 'it-dev-25',
          workItems: [
            makeWorkItem({
              id: 1100,
              areaPath: 'Delivery\\Core',
              assignedTo: ana,
              remainingWork: 6,
              column: 'To do',
              adoBoardId: 'ado-dev',
            }),
          ],
        },
      ],
      capacity: [
        ...(devTeamInput().capacity ?? []),
        {
          iterationId: 'it-dev-25',
          capacities: [makeCapacity({ ...ana, capacityPerDay: 4 })],
          teamDaysOff: null,
        },
      ],
    };
    const snapshot = assembleBoardSnapshot(
      makeInput(
        { teams: [twoSprints] },
        {
          alignment: {
            mode: 'date-window',
            window: { start: '2026-09-20', end: '2026-10-01' },
          },
        },
      ),
    );
    expect(ids(snapshot.cards)).toContain(1100);
    expect(
      snapshot.cards.find((card) => card.workItemId === 1100)?.iterationId,
    ).toBe('it-dev-25');
    // One badge per team, the earliest iteration in the window.
    expect(snapshot.teams.map((team) => team.iteration.iterationId)).toEqual([
      'it-dev-24',
    ]);
    const anaLoad = snapshot.personLoad.find(
      (load) => load.descriptor === 'aad.ana',
    );
    expect(anaLoad?.perTeam.map((team) => team.iterationId)).toEqual([
      'it-dev-24',
      'it-dev-25',
    ]);
    expect(anaLoad?.capacityHours).toBe(80);
    expect(snapshot.burndown).toBe('suppressed-mismatched-windows');
  });
});

describe('determinism', () => {
  it('produces an identical snapshot for identical input', () => {
    expect(assembleBoardSnapshot(makeInput())).toEqual(
      assembleBoardSnapshot(makeInput()),
    );
  });

  it('does not depend on the order teams came back in', () => {
    const forward = assembleBoardSnapshot(makeInput());
    const reversed = assembleBoardSnapshot(
      makeInput({ teams: [dataTeamInput(), devTeamInput()] }),
    );
    expect(ids(reversed.cards)).toEqual(ids(forward.cards));
    expect(reversed.swimlanes).toEqual(forward.swimlanes);
    expect(reversed.teams).toEqual(forward.teams);
    expect(reversed.unmappedColumns).toEqual(forward.unmappedColumns);
  });

  it('does not depend on the order work items came back in', () => {
    const shuffled: TeamSnapshotInput = {
      ...devTeamInput(),
      workItems: devTeamInput().workItems.map((batch) => ({
        ...batch,
        workItems: [...batch.workItems].reverse(),
      })),
    };
    expect(
      ids(assembleBoardSnapshot(makeInput({ teams: [shuffled] })).cards),
    ).toEqual([1003, 1001, 1004, 1002]);
  });
});

describe('buildSnapshotParts', () => {
  it('exposes the index, scopes and card partitions without the envelope', () => {
    const parts = buildSnapshotParts(
      makeInput({ isCardVisible: (card) => card.teamId === 'team-dev' }),
    );
    expect(parts.index.columns.map((column) => column.id)).toEqual([
      'col-todo',
      'col-doing',
      'col-done',
    ]);
    expect(
      parts.scopes.map((scope) => scope.primary?.window.iterationId),
    ).toEqual(['it-dev-24', 'it-data-12']);
    expect(ids(parts.cards)).toEqual([1003, 1001, 1004, 1002]);
    expect(ids(parts.trimmedCards)).toEqual([2001, 2002]);
    expect(parts.hiddenByOverride).toEqual([]);
  });
});
