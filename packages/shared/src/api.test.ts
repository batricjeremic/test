import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  boardSnapshotQuerySchema,
  boardSnapshotSchema,
} from './api.js';
import { EMPTY_BOARD_FILTER_SET } from './filters.js';
import {
  cardDeltaSchema,
  DEFAULT_POLL_INTERVAL_SECONDS,
  realtimeEnvelopeSchema,
  REALTIME_PROTOCOL_VERSION,
} from './realtime.js';

const card = {
  workItemId: 4211,
  project: 'Delivery',
  teamId: 'team-dev',
  iterationId: 'iter-24',
  title: 'Wire the aggregated board',
  type: 'User Story',
  assignedTo: { descriptor: 'aad.YWJj', displayName: 'A. Person' },
  state: 'Active',
  sourceColumn: 'In Review',
  canonicalColumnId: 'col-review',
  remainingWork: 4,
  tags: ['ui'],
  rev: 7,
};

const iteration = {
  projectId: 'proj-1',
  projectName: 'Delivery',
  teamId: 'team-dev',
  teamName: 'Dev',
  iterationId: 'iter-24',
  iterationPath: 'Delivery\\Sprint 24',
  iterationName: 'Sprint 24',
  startDate: '2026-09-14T00:00:00Z',
  finishDate: '2026-10-02T00:00:00Z',
  workingDaysTotal: 15,
  workingDaysElapsed: 2,
};

const snapshot = {
  boardId: 'board-1',
  boardName: 'Delivery — all divisions',
  orgId: 'expertgroup',
  generatedAt: '2026-09-17T08:00:00Z',
  traceId: 'trace-1',
  cache: { hit: true, ageSeconds: 12, degraded: false },
  grouping: 'person' as const,
  alignment: { mode: 'each-team-current' as const },
  filters: EMPTY_BOARD_FILTER_SET,
  columns: [
    {
      id: 'col-review',
      boardId: 'board-1',
      name: 'In Review',
      order: 2,
      stateCategory: 'InProgress' as const,
    },
  ],
  teams: [
    {
      projectId: 'proj-1',
      teamId: 'team-dev',
      backlogLevel: 'Microsoft.RequirementCategory',
      iteration,
      mappedCanonicalColumnIds: ['col-review'],
      writable: true,
    },
  ],
  swimlanes: [
    {
      id: '__unassigned__',
      kind: 'unassigned' as const,
      label: 'Unassigned',
      personDescriptor: null,
      teamId: null,
      order: 0,
      cardCount: 2,
      hiddenCardCount: 1,
      remainingWorkHours: 6,
      cardsWithoutRemainingWork: 1,
    },
  ],
  cards: [card],
  personLoad: [],
  unmappedColumns: [
    {
      projectId: 'proj-2',
      teamId: 'team-data',
      teamName: 'Data and AI',
      sourceColumn: 'Blocked',
      cardCount: 3,
    },
  ],
  permissions: {
    descriptor: 'aad.YWJj',
    readableProjectIds: ['proj-1', 'proj-2'],
    writableProjectIds: ['proj-1'],
    canAdminister: false,
  },
  realtime: {
    mode: 'polling' as const,
    channel: 'board:board-1',
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    reason: 'service-hooks-missing' as const,
  },
  burndown: 'suppressed-mismatched-windows' as const,
  hiddenCardCount: 1,
};

describe('boardSnapshotSchema', () => {
  it('round-trips a full snapshot', () => {
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('keeps the trimmed-card count so an empty lane still says so', () => {
    const parsed = boardSnapshotSchema.parse(snapshot);
    expect(parsed.swimlanes[0]?.hiddenCardCount).toBe(1);
    expect(parsed.hiddenCardCount).toBe(1);
  });

  it('rejects a snapshot whose grouping is not person or team', () => {
    const result = boardSnapshotSchema.safeParse({
      ...snapshot,
      grouping: 'project',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a snapshot with no permissions block', () => {
    const { permissions: _permissions, ...rest } = snapshot;
    expect(boardSnapshotSchema.safeParse(rest).success).toBe(false);
  });
});

describe('boardSnapshotQuerySchema', () => {
  it('defaults to each-team-current, board grouping and no filters', () => {
    expect(boardSnapshotQuerySchema.parse({})).toEqual({
      alignment: { mode: 'each-team-current' },
      grouping: null,
      filters: EMPTY_BOARD_FILTER_SET,
    });
  });

  it('rejects a date-window query with a reversed window', () => {
    const result = boardSnapshotQuerySchema.safeParse({
      alignment: {
        mode: 'date-window',
        window: { start: '2026-10-01', end: '2026-09-01' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('realtime', () => {
  it('round-trips a card-moved envelope', () => {
    const envelope = {
      v: REALTIME_PROTOCOL_VERSION,
      boardId: 'board-1',
      channel: 'board:board-1',
      sequence: 42,
      emittedAt: '2026-09-17T08:00:00Z',
      traceId: 'trace-1',
      origin: 'service-hook' as const,
      delta: {
        kind: 'card-moved' as const,
        workItemId: 4211,
        rev: 8,
        fromCanonicalColumnId: 'col-doing',
        toCanonicalColumnId: 'col-review',
        sourceColumn: 'In Review',
        state: 'Active',
        assignedTo: null,
      },
    };
    expect(realtimeEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('round-trips an upsert and a removal', () => {
    const upsert = { kind: 'card-upserted' as const, card };
    const removal = {
      kind: 'card-removed' as const,
      workItemId: 4211,
      cause: 'out-of-scope' as const,
    };
    expect(cardDeltaSchema.parse(upsert)).toEqual(upsert);
    expect(cardDeltaSchema.parse(removal)).toEqual(removal);
  });

  it('rejects an envelope from a different protocol version', () => {
    const result = realtimeEnvelopeSchema.safeParse({
      v: 2,
      boardId: 'board-1',
      channel: 'board:board-1',
      sequence: 1,
      emittedAt: '2026-09-17T08:00:00Z',
      traceId: 'trace-1',
      origin: 'own-write',
      delta: { kind: 'card-upserted', card },
    });
    expect(result.success).toBe(false);
  });
});

describe('apiErrorSchema', () => {
  it('round-trips an error body', () => {
    const error = {
      code: 'revision_conflict',
      message: 'Someone else changed this card. It has been refreshed.',
      status: 409,
      traceId: 'trace-1',
    };
    expect(apiErrorSchema.parse(error)).toEqual(error);
  });

  it('rejects a status outside the error range', () => {
    const result = apiErrorSchema.safeParse({
      code: 'ok',
      message: 'fine',
      status: 200,
      traceId: 'trace-1',
    });
    expect(result.success).toBe(false);
  });
});
