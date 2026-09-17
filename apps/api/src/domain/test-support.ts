/**
 * Builders for the domain tests.
 *
 * Every fake here is a plain value: a fixed `Clock`, raw Azure DevOps
 * shapes and configuration rows. No test in this module needs a live
 * Redis, Postgres or Azure DevOps, which is the whole point of keeping
 * the domain pure.
 */
import type {
  BoardDefinition,
  BoardPermissions,
  CanonicalColumn,
  ColumnMapping,
  RealtimeStatus,
  SnapshotCacheInfo,
} from '@eg/shared';
import { DEFAULT_POLL_INTERVAL_SECONDS } from '@eg/shared';
import type {
  AdoBoard,
  AdoBoardColumn,
  AdoDateRange,
  AdoTeamMemberCapacity,
  AdoTeamSettingsIteration,
  AdoWorkItem,
} from '../ado/types.js';
import { ADO_FIELDS, kanbanColumnFieldName } from '../ado/types.js';
import type { Clock } from '../ports.js';
import type { TeamBoardContext } from './mapping.js';
import { buildTeamBoardContext } from './mapping.js';

export const BOARD_ID = 'board-delivery';
export const ORG_ID = 'org-expertgroup';

/** A clock that never moves, so working-day maths is reproducible. */
export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: () => new Date(instant.getTime()) };
}

export interface ColumnSpec {
  readonly name: string;
  readonly id?: string;
  readonly isSplit?: boolean;
}

export function makeAdoBoard(
  boardId: string,
  columns: readonly (string | ColumnSpec)[],
): AdoBoard {
  const built: AdoBoardColumn[] = columns.map((column, position) => {
    const spec: ColumnSpec =
      typeof column === 'string' ? { name: column } : column;
    return {
      id: spec.id ?? `${boardId}-col-${position}`,
      name: spec.name,
      ...(spec.isSplit === true ? { isSplit: true } : {}),
    };
  });
  return { id: boardId, name: `${boardId} board`, columns: built };
}

export interface TeamSpec {
  readonly teamId: string;
  readonly teamName?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly backlogLevel?: string;
  readonly adoBoardId?: string;
  readonly columns?: readonly (string | ColumnSpec)[];
}

export function makeTeam(spec: TeamSpec): TeamBoardContext {
  const adoBoardId = spec.adoBoardId ?? `ado-${spec.teamId}`;
  return buildTeamBoardContext({
    source: {
      boardId: BOARD_ID,
      projectId: spec.projectId ?? 'Delivery',
      teamId: spec.teamId,
      backlogLevel: spec.backlogLevel ?? 'Microsoft.RequirementCategory',
    },
    board: makeAdoBoard(adoBoardId, spec.columns ?? ['To do', 'Doing', 'Done']),
    projectName: spec.projectName ?? spec.projectId ?? 'Delivery',
    teamName: spec.teamName ?? spec.teamId,
  });
}

export interface WorkItemSpec {
  readonly id: number;
  readonly rev?: number;
  readonly title?: string;
  readonly type?: string;
  readonly state?: string;
  readonly areaPath?: string;
  readonly assignedTo?: {
    readonly descriptor: string;
    readonly displayName?: string;
  } | null;
  readonly remainingWork?: number | null;
  readonly tags?: readonly string[];
  /** The `WEF_..._Kanban.Column` value. */
  readonly column?: string | null;
  /** Which board's WEF field the column is written to. */
  readonly adoBoardId?: string;
  readonly columnField?: string;
  readonly extraFields?: Readonly<Record<string, unknown>>;
}

export function makeWorkItem(spec: WorkItemSpec): AdoWorkItem {
  const fields: Record<string, unknown> = {
    [ADO_FIELDS.title]: spec.title ?? `Work item ${spec.id}`,
    [ADO_FIELDS.workItemType]: spec.type ?? 'User Story',
    [ADO_FIELDS.state]: spec.state ?? 'Active',
  };
  if (spec.areaPath !== undefined) fields[ADO_FIELDS.areaPath] = spec.areaPath;
  if (spec.assignedTo !== undefined && spec.assignedTo !== null) {
    fields[ADO_FIELDS.assignedTo] = {
      descriptor: spec.assignedTo.descriptor,
      displayName: spec.assignedTo.displayName ?? 'Someone',
    };
  }
  if (spec.remainingWork !== undefined && spec.remainingWork !== null) {
    fields[ADO_FIELDS.remainingWork] = spec.remainingWork;
  }
  if (spec.tags !== undefined && spec.tags.length > 0) {
    fields[ADO_FIELDS.tags] = spec.tags.join('; ');
  }
  if (spec.column !== undefined && spec.column !== null) {
    const field =
      spec.columnField ??
      kanbanColumnFieldName(spec.adoBoardId ?? 'ado-team-dev');
    fields[field] = spec.column;
  }
  for (const [key, value] of Object.entries(spec.extraFields ?? {})) {
    fields[key] = value;
  }
  return { id: spec.id, rev: spec.rev ?? 1, fields };
}

export interface IterationSpec {
  readonly id: string;
  readonly name?: string;
  readonly path?: string;
  readonly start?: string | null;
  readonly finish?: string | null;
  readonly timeFrame?: 'past' | 'current' | 'future';
}

export function makeIteration(spec: IterationSpec): AdoTeamSettingsIteration {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    path: spec.path ?? `Delivery\\${spec.name ?? spec.id}`,
    attributes: {
      startDate: spec.start ?? null,
      finishDate: spec.finish ?? null,
      ...(spec.timeFrame === undefined ? {} : { timeFrame: spec.timeFrame }),
    },
  };
}

export interface CapacitySpec {
  readonly descriptor: string;
  readonly displayName?: string;
  readonly capacityPerDay?: number;
  readonly activities?: readonly number[];
  readonly daysOff?: readonly AdoDateRange[];
}

export function makeCapacity(spec: CapacitySpec): AdoTeamMemberCapacity {
  const perDay = spec.activities ?? [spec.capacityPerDay ?? 6];
  return {
    teamMember: {
      descriptor: spec.descriptor,
      displayName: spec.displayName ?? 'Someone',
    },
    activities: perDay.map((capacityPerDay) => ({
      capacityPerDay,
      name: null,
    })),
    daysOff: [...(spec.daysOff ?? [])],
  };
}

export function days(start: string, end?: string): AdoDateRange {
  return { start, end: end ?? start };
}

export function makeCanonicalColumns(): CanonicalColumn[] {
  return [
    {
      id: 'col-todo',
      boardId: BOARD_ID,
      name: 'To do',
      order: 0,
      stateCategory: 'Proposed',
    },
    {
      id: 'col-doing',
      boardId: BOARD_ID,
      name: 'In progress',
      order: 1,
      stateCategory: 'InProgress',
    },
    {
      id: 'col-done',
      boardId: BOARD_ID,
      name: 'Done',
      order: 2,
      stateCategory: 'Completed',
    },
  ];
}

export function makeMapping(
  teamId: string,
  sourceColumnId: string,
  canonicalColumnId: string,
  targetState: string | null = null,
): ColumnMapping {
  return {
    boardId: BOARD_ID,
    teamId,
    sourceColumnId,
    canonicalColumnId,
    targetState,
  };
}

export function makeDefinition(
  overrides: Partial<BoardDefinition> = {},
): BoardDefinition {
  return {
    id: BOARD_ID,
    name: 'Delivery — all divisions',
    orgId: ORG_ID,
    defaultGrouping: 'person',
    ownerDescriptor: 'aad.owner',
    ...overrides,
  };
}

export function makePermissions(
  overrides: Partial<BoardPermissions> = {},
): BoardPermissions {
  return {
    descriptor: 'aad.reader',
    readableProjectIds: ['Delivery', 'Data'],
    writableProjectIds: ['Delivery', 'Data'],
    canAdminister: false,
    ...overrides,
  };
}

export const CACHE_MISS: SnapshotCacheInfo = {
  hit: false,
  ageSeconds: 0,
  degraded: false,
};

export const LIVE_REALTIME: RealtimeStatus = {
  mode: 'live',
  channel: `board:${BOARD_ID}`,
  pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  reason: null,
};
