/**
 * A configuration an admin would actually recognise: two teams that both
 * have a column called "In Review", one of which nobody has mapped yet.
 *
 * Used by this folder's tests and by the standalone dev shell.
 */
import type {
  BoardDefinition,
  BoardSnapshot,
  BoardSource,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';
import {
  FIXTURE_BOARD_ID,
  FIXTURE_COLUMNS,
  FIXTURE_ORG_ID,
  makeBoardSnapshot,
  makeBoardTeamView,
  makeTeamIterationWindow,
} from '../api/fixtures';
import type { AdminDraft } from './types';

export const ADMIN_FIXTURE_DEFINITION: BoardDefinition = {
  id: FIXTURE_BOARD_ID,
  name: 'Delivery — all divisions',
  orgId: FIXTURE_ORG_ID,
  defaultGrouping: 'person',
  ownerDescriptor: 'aad.ana',
};

export const ADMIN_FIXTURE_SOURCES: BoardSource[] = [
  {
    boardId: FIXTURE_BOARD_ID,
    projectId: 'Delivery',
    teamId: 'team-dev',
    backlogLevel: 'Microsoft.RequirementCategory',
  },
  {
    boardId: FIXTURE_BOARD_ID,
    projectId: 'Data and AI',
    teamId: 'team-data',
    backlogLevel: 'Microsoft.RequirementCategory',
  },
];

/** Dev is fully mapped; Data and AI has one column nobody has mapped. */
export const ADMIN_FIXTURE_MAPPINGS: ColumnMapping[] = [
  {
    boardId: FIXTURE_BOARD_ID,
    teamId: 'team-dev',
    sourceColumnId: 'Doing',
    canonicalColumnId: 'col-doing',
    targetState: null,
  },
  {
    boardId: FIXTURE_BOARD_ID,
    teamId: 'team-dev',
    sourceColumnId: 'In Review',
    canonicalColumnId: 'col-review',
    targetState: null,
  },
  {
    boardId: FIXTURE_BOARD_ID,
    teamId: 'team-data',
    sourceColumnId: 'Doing',
    canonicalColumnId: 'col-doing',
    targetState: null,
  },
];

export const ADMIN_FIXTURE_OVERRIDES: PersonOverride[] = [
  {
    boardId: FIXTURE_BOARD_ID,
    descriptor: 'aad.svc.build',
    displayName: 'Build service',
    hidden: true,
  },
];

/** The same board as a snapshot, so team names and card counts resolve. */
export function makeAdminSnapshot(): BoardSnapshot {
  return makeBoardSnapshot({
    teams: [
      makeBoardTeamView(),
      makeBoardTeamView({
        projectId: 'Data and AI',
        teamId: 'team-data',
        iteration: makeTeamIterationWindow({
          projectId: 'Data and AI',
          projectName: 'Data and AI',
          teamId: 'team-data',
          teamName: 'Data and AI',
          iterationId: 'iteration-data-12',
          iterationName: 'Sprint 12',
        }),
        mappedCanonicalColumnIds: ['col-doing'],
      }),
    ],
    unmappedColumns: [
      {
        projectId: 'Data and AI',
        teamId: 'team-data',
        teamName: 'Data and AI',
        sourceColumn: 'In Review',
        cardCount: 3,
      },
    ],
  });
}

/** The same configuration as an in-memory draft. */
export function makeAdminDraft(
  overrides: Partial<AdminDraft> = {},
): AdminDraft {
  return {
    definition: ADMIN_FIXTURE_DEFINITION,
    sources: ADMIN_FIXTURE_SOURCES,
    columns: FIXTURE_COLUMNS,
    mappings: ADMIN_FIXTURE_MAPPINGS,
    overrides: ADMIN_FIXTURE_OVERRIDES,
    ...overrides,
  };
}
