import { describe, expect, it } from 'vitest';
import { UNASSIGNED_LANE_ID } from '@eg/shared';
import type { BoardCard, PersonOverride } from '@eg/shared';
import {
  buildSwimlanes,
  hiddenDescriptors,
  partitionHiddenCards,
  personLaneId,
  teamLaneId,
} from './swimlanes.js';
import { makeTeam } from './test-support.js';

const dev = makeTeam({
  teamId: 'team-dev',
  teamName: 'Dev',
  projectId: 'Delivery',
  projectName: 'Delivery',
});
const data = makeTeam({
  teamId: 'team-data',
  teamName: 'Data and AI',
  projectId: 'Data',
  projectName: 'Data',
});

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    workItemId: 1,
    project: 'Delivery',
    teamId: 'team-dev',
    iterationId: 'it-1',
    title: 'Card',
    type: 'Task',
    assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
    state: 'Active',
    sourceColumn: 'Doing',
    canonicalColumnId: 'col-doing',
    remainingWork: 4,
    tags: [],
    rev: 1,
    ...overrides,
  };
}

describe('grouping by person', () => {
  const cards = [
    card({ workItemId: 1, remainingWork: 4 }),
    card({ workItemId: 2, remainingWork: null }),
    card({
      workItemId: 3,
      assignedTo: { descriptor: 'aad.zoran', displayName: 'Zoran Petrovic' },
      remainingWork: 2.5,
    }),
    card({ workItemId: 4, assignedTo: null, remainingWork: 1 }),
    card({
      workItemId: 5,
      assignedTo: { descriptor: 'vssgp.Delivery', displayName: 'Delivery' },
      remainingWork: null,
    }),
  ];

  it('pins the Unassigned lane at the top and puts group cards in it', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards,
      teams: [dev],
    });
    expect(lanes[0]).toMatchObject({
      id: UNASSIGNED_LANE_ID,
      kind: 'unassigned',
      label: 'Unassigned',
      order: 0,
      cardCount: 2,
      remainingWorkHours: 1,
      cardsWithoutRemainingWork: 1,
      personDescriptor: null,
      teamId: null,
    });
  });

  it('gives each person one lane, with hours and card count side by side', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards,
      teams: [dev],
    });
    expect(lanes.map((lane) => lane.id)).toEqual([
      UNASSIGNED_LANE_ID,
      personLaneId('aad.ana'),
      personLaneId('aad.zoran'),
    ]);
    expect(lanes[1]).toMatchObject({
      kind: 'person',
      label: 'Ana Ilic',
      personDescriptor: 'aad.ana',
      order: 1,
      cardCount: 2,
      remainingWorkHours: 4,
      cardsWithoutRemainingWork: 1,
    });
  });

  it('keeps the Unassigned lane even when nothing is in it', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards: [],
      teams: [dev],
    });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id: UNASSIGNED_LANE_ID, cardCount: 0 });
  });

  it('orders people by display name whatever the card order', () => {
    const forward = buildSwimlanes({ grouping: 'person', cards, teams: [dev] });
    const reversed = buildSwimlanes({
      grouping: 'person',
      cards: [...cards].reverse(),
      teams: [dev],
    });
    expect(reversed.map((lane) => lane.id)).toEqual(
      forward.map((lane) => lane.id),
    );
  });

  it('labels a lane with the person override when there is one', () => {
    const overrides: PersonOverride[] = [
      {
        boardId: 'board-delivery',
        descriptor: 'aad.ana',
        displayName: 'A. Ilic (contract)',
        hidden: false,
      },
    ];
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards,
      teams: [dev],
      overrides,
    });
    expect(lanes[1]?.label).toBe('A. Ilic (contract)');
  });

  it('falls back to the descriptor when no name is known', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards: [card({ assignedTo: { descriptor: 'aad.x', displayName: '' } })],
      teams: [dev],
    });
    expect(lanes[1]?.label).toBe('aad.x');
  });
});

describe('grouping by team', () => {
  it('gives every team in scope a lane, ordered by project then team', () => {
    const lanes = buildSwimlanes({
      grouping: 'team',
      cards: [
        card({ workItemId: 1 }),
        card({ workItemId: 2, teamId: 'team-data', project: 'Data' }),
      ],
      teams: [dev, data],
    });
    expect(lanes.map((lane) => lane.id)).toEqual([
      teamLaneId('team-data'),
      teamLaneId('team-dev'),
    ]);
    expect(lanes[0]).toMatchObject({
      kind: 'team',
      label: 'Data and AI',
      teamId: 'team-data',
      personDescriptor: null,
      order: 0,
      cardCount: 1,
    });
  });

  it('shows a team with no cards rather than hiding it', () => {
    const lanes = buildSwimlanes({
      grouping: 'team',
      cards: [],
      teams: [dev, data],
    });
    expect(lanes).toHaveLength(2);
    expect(lanes.every((lane) => lane.cardCount === 0)).toBe(true);
  });

  it('does not invent an Unassigned lane it would never use', () => {
    const lanes = buildSwimlanes({
      grouping: 'team',
      cards: [card({})],
      teams: [dev],
    });
    expect(lanes.some((lane) => lane.kind === 'unassigned')).toBe(false);
  });

  it('catches a card whose team is not on the board', () => {
    const lanes = buildSwimlanes({
      grouping: 'team',
      cards: [card({ teamId: 'team-ghost' })],
      teams: [dev],
    });
    expect(lanes[0]).toMatchObject({
      id: UNASSIGNED_LANE_ID,
      order: 0,
      cardCount: 1,
    });
  });
});

describe('security trimming', () => {
  it('still shows a lane whose cards were all trimmed, with a count', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards: [],
      trimmedCards: [
        card({
          workItemId: 9,
          assignedTo: { descriptor: 'aad.mira', displayName: 'Mira Kovac' },
        }),
      ],
      teams: [dev],
    });
    const lane = lanes.find((entry) => entry.kind === 'person');
    expect(lane).toMatchObject({
      label: 'Mira Kovac',
      cardCount: 0,
      hiddenCardCount: 1,
      remainingWorkHours: 0,
    });
  });

  it('counts trimmed cards without leaking their hours', () => {
    const lanes = buildSwimlanes({
      grouping: 'person',
      cards: [card({ workItemId: 1, remainingWork: 4 })],
      trimmedCards: [card({ workItemId: 2, remainingWork: 40 })],
      teams: [dev],
    });
    expect(lanes[1]).toMatchObject({
      cardCount: 1,
      hiddenCardCount: 1,
      remainingWorkHours: 4,
    });
  });
});

describe('person overrides that hide people', () => {
  const overrides: PersonOverride[] = [
    {
      boardId: 'board-delivery',
      descriptor: 'aad.zoran',
      displayName: 'Zoran Petrovic',
      hidden: true,
    },
    {
      boardId: 'board-delivery',
      descriptor: 'aad.ana',
      displayName: 'Ana Ilic',
      hidden: false,
    },
  ];

  it('collects the hidden descriptors', () => {
    expect([...hiddenDescriptors(overrides)]).toEqual(['aad.zoran']);
  });

  it('splits their cards off rather than dropping them into Unassigned', () => {
    const cards = [
      card({ workItemId: 1 }),
      card({
        workItemId: 2,
        assignedTo: { descriptor: 'aad.zoran', displayName: 'Zoran Petrovic' },
      }),
      card({ workItemId: 3, assignedTo: null }),
    ];
    const split = partitionHiddenCards(cards, hiddenDescriptors(overrides));
    expect(split.visible.map((entry) => entry.workItemId)).toEqual([1, 3]);
    expect(split.hidden.map((entry) => entry.workItemId)).toEqual([2]);

    const lanes = buildSwimlanes({
      grouping: 'person',
      cards: split.visible,
      teams: [dev],
      overrides,
    });
    expect(lanes.some((lane) => lane.personDescriptor === 'aad.zoran')).toBe(
      false,
    );
    expect(lanes.find((lane) => lane.kind === 'unassigned')?.cardCount).toBe(1);
  });
});
