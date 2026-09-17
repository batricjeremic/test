/**
 * Fixtures for tests and for the standalone dev shell.
 *
 * Every builder returns a value that satisfies the matching Zod schema in
 * `@eg/shared`, so a test that renders a fixture is rendering something
 * the BFF could actually have sent.
 */
import {
  DEFAULT_ITERATION_ALIGNMENT,
  DEFAULT_POLL_INTERVAL_SECONDS,
  EMPTY_BOARD_FILTER_SET,
  UNASSIGNED_LANE_ID,
} from '@eg/shared';
import type {
  BoardCard,
  BoardPermissions,
  BoardSnapshot,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
  PersonLoad,
  RealtimeStatus,
  TeamIterationWindow,
} from '@eg/shared';

export const FIXTURE_BOARD_ID = 'board-delivery';
export const FIXTURE_ORG_ID = 'org-expertgroup';
export const FIXTURE_TIMESTAMP = '2026-09-17T08:00:00.000Z';

export function makeCanonicalColumn(
  overrides: Partial<CanonicalColumn> = {},
): CanonicalColumn {
  return {
    id: 'col-todo',
    boardId: FIXTURE_BOARD_ID,
    name: 'To do',
    order: 0,
    stateCategory: 'Proposed',
    ...overrides,
  };
}

export const FIXTURE_COLUMNS: CanonicalColumn[] = [
  makeCanonicalColumn({ id: 'col-todo', name: 'To do', order: 0 }),
  makeCanonicalColumn({
    id: 'col-doing',
    name: 'In progress',
    order: 1,
    stateCategory: 'InProgress',
  }),
  makeCanonicalColumn({
    id: 'col-review',
    name: 'In review',
    order: 2,
    stateCategory: 'InProgress',
  }),
  makeCanonicalColumn({
    id: 'col-done',
    name: 'Done',
    order: 3,
    stateCategory: 'Completed',
  }),
];

export function makeBoardCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    workItemId: 1001,
    project: 'Delivery',
    teamId: 'team-dev',
    iterationId: 'iteration-dev-24',
    title: 'Wire the hub to the BFF',
    type: 'User Story',
    assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
    state: 'Active',
    sourceColumn: 'Doing',
    canonicalColumnId: 'col-doing',
    remainingWork: 4,
    tags: ['hub'],
    rev: 7,
    ...overrides,
  };
}

export function makeTeamIterationWindow(
  overrides: Partial<TeamIterationWindow> = {},
): TeamIterationWindow {
  return {
    projectId: 'Delivery',
    projectName: 'Delivery',
    teamId: 'team-dev',
    teamName: 'Dev',
    iterationId: 'iteration-dev-24',
    iterationPath: 'Delivery\\Sprint 24',
    iterationName: 'Sprint 24',
    startDate: '2026-09-15T00:00:00.000Z',
    finishDate: '2026-09-26T00:00:00.000Z',
    workingDaysTotal: 10,
    workingDaysElapsed: 2,
    ...overrides,
  };
}

export function makeBoardTeamView(
  overrides: Partial<BoardTeamView> = {},
): BoardTeamView {
  return {
    projectId: 'Delivery',
    teamId: 'team-dev',
    backlogLevel: 'Microsoft.RequirementCategory',
    iteration: makeTeamIterationWindow(),
    mappedCanonicalColumnIds: FIXTURE_COLUMNS.map((column) => column.id),
    writable: true,
    ...overrides,
  };
}

export function makeSwimlane(
  overrides: Partial<BoardSwimlane> = {},
): BoardSwimlane {
  return {
    id: 'lane-ana',
    kind: 'person',
    label: 'Ana Ilic',
    personDescriptor: 'aad.ana',
    teamId: null,
    order: 1,
    cardCount: 1,
    hiddenCardCount: 0,
    remainingWorkHours: 4,
    cardsWithoutRemainingWork: 0,
    ...overrides,
  };
}

export function makeUnassignedSwimlane(): BoardSwimlane {
  return makeSwimlane({
    id: UNASSIGNED_LANE_ID,
    kind: 'unassigned',
    label: 'Unassigned',
    personDescriptor: null,
    order: 0,
    cardCount: 0,
    remainingWorkHours: 0,
  });
}

export function makePersonLoad(
  overrides: Partial<PersonLoad> = {},
): PersonLoad {
  return {
    descriptor: 'aad.ana',
    displayName: 'Ana Ilic',
    hidden: false,
    capacityHours: 60,
    committedHours: 42,
    load: 0.7,
    partialCapacity: false,
    outOfScopeTeamCount: 0,
    cardCount: 6,
    cardsWithoutRemainingWork: 1,
    perTeam: [
      {
        projectId: 'Delivery',
        teamId: 'team-dev',
        teamName: 'Dev',
        iterationId: 'iteration-dev-24',
        hasCapacityRecord: true,
        capacityPerDay: 6,
        workingDays: 10,
        daysOff: 0,
        capacityHours: 60,
        committedHours: 42,
        cardCount: 6,
      },
    ],
    computedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  };
}

export function makeBoardPermissions(
  overrides: Partial<BoardPermissions> = {},
): BoardPermissions {
  return {
    descriptor: 'aad.ana',
    readableProjectIds: ['Delivery', 'Data and AI'],
    writableProjectIds: ['Delivery'],
    canAdminister: true,
    ...overrides,
  };
}

export function makeRealtimeStatus(
  overrides: Partial<RealtimeStatus> = {},
): RealtimeStatus {
  return {
    mode: 'live',
    channel: `board:${FIXTURE_BOARD_ID}`,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    reason: null,
    ...overrides,
  };
}

/** A complete, schema-valid snapshot: four columns, two lanes, two cards. */
export function makeBoardSnapshot(
  overrides: Partial<BoardSnapshot> = {},
): BoardSnapshot {
  return {
    boardId: FIXTURE_BOARD_ID,
    boardName: 'Delivery — all divisions',
    orgId: FIXTURE_ORG_ID,
    generatedAt: FIXTURE_TIMESTAMP,
    traceId: 'trace-fixture',
    cache: { hit: true, ageSeconds: 12, degraded: false },
    grouping: 'person',
    alignment: DEFAULT_ITERATION_ALIGNMENT,
    filters: EMPTY_BOARD_FILTER_SET,
    columns: FIXTURE_COLUMNS,
    teams: [makeBoardTeamView()],
    swimlanes: [makeUnassignedSwimlane(), makeSwimlane()],
    cards: [
      makeBoardCard(),
      makeBoardCard({
        workItemId: 1002,
        title: 'Map the Data and AI columns',
        canonicalColumnId: 'col-todo',
        sourceColumn: 'New',
        state: 'New',
        rev: 3,
      }),
    ],
    personLoad: [makePersonLoad()],
    unmappedColumns: [],
    permissions: makeBoardPermissions(),
    realtime: makeRealtimeStatus(),
    burndown: 'available',
    hiddenCardCount: 0,
    ...overrides,
  };
}
