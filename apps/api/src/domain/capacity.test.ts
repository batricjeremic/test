import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ITERATION_ALIGNMENT,
  DEFAULT_LOAD_THRESHOLD,
} from '@eg/shared';
import type { BoardCard, PersonLoad } from '@eg/shared';
import {
  availableWorkingDays,
  capacityDescriptorOf,
  capacityPerDayOf,
  computePersonLoads,
} from './capacity.js';
import type { TeamCapacityInput } from './capacity.js';
import type { ResolvedTeamIteration } from './iteration.js';
import { resolveTeamIterationScope } from './iteration.js';
import type { TeamBoardContext } from './mapping.js';
import {
  days,
  fixedClock,
  makeCapacity,
  makeIteration,
  makeTeam,
} from './test-support.js';
import type { Weekday } from './working-days.js';

const NOW = '2026-09-17T09:00:00.000Z';
const clock = fixedClock(NOW);

const FOUR_DAY: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
];

const dev = makeTeam({ teamId: 'team-dev', teamName: 'Dev' });
const data = makeTeam({
  teamId: 'team-data',
  teamName: 'Data and AI',
  projectId: 'Data',
});
const platform = makeTeam({
  teamId: 'team-platform',
  teamName: 'Platform',
  projectId: 'Delivery',
});

/** Mon 14 Sep to Fri 25 Sep: ten working days on a five-day week. */
const sprint24 = makeIteration({
  id: 'it-dev-24',
  name: 'Sprint 24',
  start: '2026-09-14T00:00:00Z',
  finish: '2026-09-25T00:00:00Z',
  timeFrame: 'current',
});

/** Mon 14 Sep to Fri 18 Sep: a one-week iteration, five working days. */
const shortSprint = makeIteration({
  id: 'it-data-12',
  name: 'Iteration 12',
  start: '2026-09-14T00:00:00Z',
  finish: '2026-09-18T00:00:00Z',
  timeFrame: 'current',
});

function resolvePrimary(
  team: TeamBoardContext,
  iteration = sprint24,
  workingDays?: readonly Weekday[],
): ResolvedTeamIteration {
  const scope = resolveTeamIterationScope(
    {
      team,
      iterations: [iteration],
      ...(workingDays === undefined ? {} : { workingDays }),
    },
    DEFAULT_ITERATION_ALIGNMENT,
    clock,
  );
  const primary = scope.primary;
  if (primary === null) throw new Error('fixture resolved no iteration');
  return primary;
}

interface CardSpec {
  readonly id: number;
  readonly descriptor?: string | null;
  readonly displayName?: string;
  readonly teamId?: string;
  readonly iterationId?: string;
  readonly remainingWork?: number | null;
  readonly project?: string;
}

function makeCard(spec: CardSpec): BoardCard {
  return {
    workItemId: spec.id,
    project: spec.project ?? 'Delivery',
    teamId: spec.teamId ?? 'team-dev',
    iterationId: spec.iterationId ?? 'it-dev-24',
    title: `Card ${spec.id}`,
    type: 'Task',
    assignedTo:
      spec.descriptor === undefined || spec.descriptor === null
        ? null
        : {
            descriptor: spec.descriptor,
            displayName: spec.displayName ?? 'Ana Ilic',
          },
    state: 'Active',
    sourceColumn: 'Doing',
    canonicalColumnId: 'col-doing',
    remainingWork: spec.remainingWork ?? null,
    tags: [],
    rev: 1,
  };
}

function onlyLoad(loads: readonly PersonLoad[]): PersonLoad {
  const first = loads[0];
  if (first === undefined) throw new Error('expected one person load');
  return first;
}

describe('capacity building blocks', () => {
  it('sums a member’s activities into hours per working day', () => {
    expect(
      capacityPerDayOf(makeCapacity({ descriptor: 'a', activities: [4, 2] })),
    ).toBe(6);
    expect(
      capacityPerDayOf(makeCapacity({ descriptor: 'a', activities: [] })),
    ).toBe(0);
    expect(
      capacityPerDayOf(makeCapacity({ descriptor: 'a', activities: [-5] })),
    ).toBe(0);
  });

  it('keys a capacity record on its descriptor, ignoring groups', () => {
    expect(capacityDescriptorOf(makeCapacity({ descriptor: 'aad.ana' }))).toBe(
      'aad.ana',
    );
    expect(
      capacityDescriptorOf(makeCapacity({ descriptor: 'vssgp.Team' })),
    ).toBeNull();
    expect(
      capacityDescriptorOf({
        teamMember: { displayName: 'No id' },
        activities: [],
        daysOff: [],
      }),
    ).toBeNull();
  });

  it('removes a day off once however many records cover it', () => {
    const iteration = resolvePrimary(dev);
    expect(
      availableWorkingDays(
        iteration,
        [days('2026-09-16', '2026-09-17')],
        [days('2026-09-17', '2026-09-18')],
      ),
    ).toEqual({ workingDays: 10, daysOff: 3 });
  });

  it('never removes more days than the iteration has', () => {
    const iteration = resolvePrimary(dev);
    expect(
      availableWorkingDays(iteration, [days('2020-01-01', '2030-01-01')], []),
    ).toEqual({ workingDays: 10, daysOff: 10 });
  });
});

describe('one person, one bar, summed across their teams', () => {
  const teams: TeamCapacityInput[] = [
    {
      team: dev,
      iteration: resolvePrimary(dev),
      capacities: [
        makeCapacity({
          descriptor: 'aad.ana',
          displayName: 'Ana Ilic',
          capacityPerDay: 4,
        }),
      ],
      teamDaysOff: null,
    },
    {
      team: data,
      iteration: resolvePrimary(data, shortSprint),
      capacities: [
        makeCapacity({
          descriptor: 'aad.ana',
          displayName: 'Ana Ilic',
          capacityPerDay: 2,
        }),
      ],
      teamDaysOff: null,
    },
    {
      team: platform,
      iteration: resolvePrimary(platform),
      capacities: [
        makeCapacity({
          descriptor: 'aad.ana',
          displayName: 'Ana Ilic',
          capacityPerDay: 1,
        }),
      ],
      teamDaysOff: null,
    },
  ];

  const cards = [
    makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 12 }),
    makeCard({
      id: 2,
      descriptor: 'aad.ana',
      teamId: 'team-data',
      iterationId: 'it-data-12',
      project: 'Data',
      remainingWork: 3,
    }),
    makeCard({
      id: 3,
      descriptor: 'aad.ana',
      teamId: 'team-platform',
      remainingWork: 5,
    }),
  ];

  it('adds three capacity records up to one number', () => {
    const load = onlyLoad(computePersonLoads({ teams, cards, clock }));
    // 4x10 on Dev, 2x5 on Data and AI, 1x10 on Platform.
    expect(load.capacityHours).toBe(60);
    expect(load.committedHours).toBe(20);
    expect(load.load).toBeCloseTo(20 / 60, 3);
    expect(load.load ?? 0).toBeLessThan(DEFAULT_LOAD_THRESHOLD);
    expect(load.partialCapacity).toBe(false);
    expect(load.cardCount).toBe(3);
  });

  it('keeps the per-team split underneath, computed over each own dates', () => {
    const load = onlyLoad(computePersonLoads({ teams, cards, clock }));
    expect(load.perTeam).toEqual([
      {
        projectId: 'Data',
        teamId: 'team-data',
        teamName: 'Data and AI',
        iterationId: 'it-data-12',
        hasCapacityRecord: true,
        capacityPerDay: 2,
        workingDays: 5,
        daysOff: 0,
        capacityHours: 10,
        committedHours: 3,
        cardCount: 1,
      },
      {
        projectId: 'Delivery',
        teamId: 'team-dev',
        teamName: 'Dev',
        iterationId: 'it-dev-24',
        hasCapacityRecord: true,
        capacityPerDay: 4,
        workingDays: 10,
        daysOff: 0,
        capacityHours: 40,
        committedHours: 12,
        cardCount: 1,
      },
      {
        projectId: 'Delivery',
        teamId: 'team-platform',
        teamName: 'Platform',
        iterationId: 'it-dev-24',
        hasCapacityRecord: true,
        capacityPerDay: 1,
        workingDays: 10,
        daysOff: 0,
        capacityHours: 10,
        committedHours: 5,
        cardCount: 1,
      },
    ]);
    expect(
      load.perTeam.reduce((sum, team) => sum + team.capacityHours, 0),
    ).toBe(load.capacityHours);
  });

  it('is one entry per person however many teams they are on', () => {
    expect(computePersonLoads({ teams, cards, clock })).toHaveLength(1);
  });
});

describe('the spec’s capacity edge-case table', () => {
  it('treats a missing capacity record as zero and raises partial capacity', () => {
    const teams: TeamCapacityInput[] = [
      {
        team: dev,
        iteration: resolvePrimary(dev),
        capacities: [
          makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 6 }),
        ],
        teamDaysOff: null,
      },
      {
        team: data,
        iteration: resolvePrimary(data, shortSprint),
        capacities: [],
        teamDaysOff: null,
      },
    ];
    const load = onlyLoad(
      computePersonLoads({
        teams,
        cards: [
          makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 30 }),
          makeCard({
            id: 2,
            descriptor: 'aad.ana',
            teamId: 'team-data',
            iterationId: 'it-data-12',
            remainingWork: 30,
          }),
        ],
        clock,
      }),
    );
    expect(load.capacityHours).toBe(60);
    expect(load.committedHours).toBe(60);
    // The bar reads 100%, not the 50% a phantom second capacity would give.
    expect(load.load).toBe(1);
    expect(load.partialCapacity).toBe(true);
    expect(load.perTeam[0]).toMatchObject({
      teamId: 'team-data',
      hasCapacityRecord: false,
      capacityHours: 0,
      committedHours: 30,
    });
  });

  it('counts a card with no remaining work but excludes it from hours', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 6 }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [
          makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 8 }),
          makeCard({ id: 2, descriptor: 'aad.ana' }),
          makeCard({ id: 3, descriptor: 'aad.ana' }),
        ],
        clock,
      }),
    );
    expect(load.cardCount).toBe(3);
    expect(load.cardsWithoutRemainingWork).toBe(2);
    expect(load.committedHours).toBe(8);
  });

  it('gives group-assigned and unassigned cards no person load at all', () => {
    const loads = computePersonLoads({
      teams: [
        {
          team: dev,
          iteration: resolvePrimary(dev),
          capacities: [],
          teamDaysOff: null,
        },
      ],
      cards: [
        makeCard({ id: 1, remainingWork: 5 }),
        makeCard({ id: 2, descriptor: 'vssgp.Delivery', remainingWork: 5 }),
      ],
      clock,
    });
    expect(loads).toEqual([]);
  });

  it('excludes an out-of-scope team but counts it in the footnote', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 6 }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 6 })],
        memberships: [
          { descriptor: 'aad.ana', teamId: 'team-dev' },
          { descriptor: 'aad.ana', teamId: 'team-research' },
          { descriptor: 'aad.ana', teamId: 'team-guild' },
          { descriptor: 'aad.ana', teamId: 'team-guild' },
          { descriptor: 'aad.other', teamId: 'team-research' },
        ],
        clock,
      }),
    );
    expect(load.outOfScopeTeamCount).toBe(2);
    expect(load.perTeam).toHaveLength(1);
  });

  it('computes teams with different iteration lengths over their own dates', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 5 }),
            ],
            teamDaysOff: null,
          },
          {
            team: data,
            iteration: resolvePrimary(data, shortSprint),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 5 }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [],
        clock,
      }),
    );
    // Ten days at 5h plus five days at 5h, never ten days twice.
    expect(load.capacityHours).toBe(75);
  });

  it('never divides by zero: no capacity gives a null bar, not Infinity', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 0 }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 12 })],
        clock,
      }),
    );
    expect(load.capacityHours).toBe(0);
    expect(load.committedHours).toBe(12);
    expect(load.load).toBeNull();
    expect(Number.isFinite(load.load ?? 0)).toBe(true);
    expect(JSON.stringify(load)).toContain('"load":null');
  });
});

describe('working days, days off and four-day weeks', () => {
  it('computes a four-day-week team over its own working days', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev, sprint24, FOUR_DAY),
            capacities: [
              makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 6 }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [],
        clock,
      }),
    );
    // Eight working days, not ten.
    expect(load.capacityHours).toBe(48);
    expect(load.perTeam[0]?.workingDays).toBe(8);
  });

  it('subtracts personal and team days off, counting a shared day once', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({
                descriptor: 'aad.ana',
                capacityPerDay: 6,
                daysOff: [days('2026-09-16', '2026-09-17')],
              }),
            ],
            teamDaysOff: { daysOff: [days('2026-09-17', '2026-09-18')] },
          },
        ],
        cards: [],
        clock,
      }),
    );
    expect(load.perTeam[0]).toMatchObject({ workingDays: 10, daysOff: 3 });
    expect(load.capacityHours).toBe(42);
  });

  it('ignores a weekend day off, because it was never capacity', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({
                descriptor: 'aad.ana',
                capacityPerDay: 6,
                daysOff: [days('2026-09-19', '2026-09-20')],
              }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [],
        clock,
      }),
    );
    expect(load.capacityHours).toBe(60);
  });

  it('floors capacity at zero when days off swallow the sprint', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [
              makeCapacity({
                descriptor: 'aad.ana',
                capacityPerDay: 6,
                daysOff: [days('2026-09-01', '2026-10-31')],
              }),
            ],
            teamDaysOff: null,
          },
        ],
        cards: [makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 4 })],
        clock,
      }),
    );
    expect(load.capacityHours).toBe(0);
    expect(load.load).toBeNull();
  });
});

describe('people, names and order', () => {
  const teams: TeamCapacityInput[] = [
    {
      team: dev,
      iteration: resolvePrimary(dev),
      capacities: [
        makeCapacity({
          descriptor: 'aad.zoran',
          displayName: 'Zoran Petrovic',
          capacityPerDay: 6,
        }),
        makeCapacity({
          descriptor: 'aad.ana',
          displayName: 'Ana Ilic',
          capacityPerDay: 6,
        }),
      ],
      teamDaysOff: null,
    },
  ];

  it('lists a person with capacity and no cards at zero committed', () => {
    const loads = computePersonLoads({ teams, cards: [], clock });
    expect(loads.map((load) => load.descriptor)).toEqual([
      'aad.ana',
      'aad.zoran',
    ]);
    expect(loads[0]).toMatchObject({
      committedHours: 0,
      cardCount: 0,
      load: 0,
    });
  });

  it('orders by display name then descriptor, whatever the input order', () => {
    const reversed: TeamCapacityInput[] = [
      {
        ...(teams[0] as TeamCapacityInput),
        capacities: [...(teams[0]?.capacities ?? [])].reverse(),
      },
    ];
    expect(
      computePersonLoads({ teams: reversed, cards: [], clock }).map(
        (load) => load.descriptor,
      ),
    ).toEqual(['aad.ana', 'aad.zoran']);
  });

  it('applies a person override to the display name and hidden flag', () => {
    const loads = computePersonLoads({
      teams,
      cards: [],
      overrides: [
        {
          boardId: 'board-delivery',
          descriptor: 'aad.zoran',
          displayName: 'Z. Petrovic (contract)',
          hidden: true,
        },
      ],
      clock,
    });
    expect(loads[1]).toMatchObject({
      descriptor: 'aad.zoran',
      displayName: 'Z. Petrovic (contract)',
      hidden: true,
    });
    expect(loads[0]?.hidden).toBe(false);
  });

  it('takes the display name from a card when capacity has none', () => {
    const load = onlyLoad(
      computePersonLoads({
        teams: [
          {
            team: dev,
            iteration: resolvePrimary(dev),
            capacities: [],
            teamDaysOff: null,
          },
        ],
        cards: [
          makeCard({
            id: 1,
            descriptor: 'aad.mira',
            displayName: 'Mira Kovac',
          }),
        ],
        clock,
      }),
    );
    expect(load.displayName).toBe('Mira Kovac');
  });

  it('stamps computedAt from the injected clock', () => {
    const loads = computePersonLoads({ teams, cards: [], clock });
    expect(loads[0]?.computedAt).toBe(NOW);
  });

  it('is pure: the same input twice gives the same output', () => {
    const cards = [
      makeCard({ id: 1, descriptor: 'aad.ana', remainingWork: 3 }),
    ];
    expect(computePersonLoads({ teams, cards, clock })).toEqual(
      computePersonLoads({ teams, cards, clock }),
    );
  });
});
