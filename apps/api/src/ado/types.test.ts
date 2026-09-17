import { describe, expect, it } from 'vitest';
import {
  ADO_FIELDS,
  ADO_WORK_ITEM_BATCH_LIMIT,
  adoBoardSchema,
  adoCapacityListSchema,
  adoErrorResponseSchema,
  adoIterationListSchema,
  adoIterationWorkItemsSchema,
  adoProjectListSchema,
  adoTaskboardColumnsSchema,
  adoTeamFieldValuesSchema,
  adoTeamListSchema,
  adoTeamSettingsDaysOffSchema,
  adoWiqlResultSchema,
  adoWorkItemBatchRequestSchema,
  adoWorkItemListSchema,
  adoWorkItemUpdatedEventSchema,
  boardIdToFieldToken,
  kanbanColumnDoneFieldName,
  kanbanColumnFieldName,
  parseAdoRateLimitHeaders,
  readIdentityField,
  readKanbanColumn,
  readKanbanColumnDone,
  readNumberField,
  readStringField,
  readTagsField,
} from './types.js';

const BOARD_ID = '4a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

describe('read endpoint schemas', () => {
  it('round-trips a project list', () => {
    const payload = {
      count: 1,
      value: [
        {
          id: 'proj-1',
          name: 'Delivery',
          url: 'https://dev.azure.com/eg/_apis/projects/proj-1',
          state: 'wellFormed',
          visibility: 'private',
        },
      ],
    };
    expect(adoProjectListSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips a team list', () => {
    const payload = {
      count: 1,
      value: [{ id: 'team-dev', name: 'Dev', projectId: 'proj-1' }],
    };
    expect(adoTeamListSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips team field values, which resolve a card to a team', () => {
    const payload = {
      field: { referenceName: 'System.AreaPath' },
      defaultValue: 'Delivery\\Dev',
      values: [{ value: 'Delivery\\Dev', includeChildren: true }],
    };
    expect(adoTeamFieldValuesSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips a current iteration with null dates', () => {
    const payload = {
      count: 1,
      value: [
        {
          id: 'iter-24',
          name: 'Sprint 24',
          path: 'Delivery\\Sprint 24',
          attributes: {
            startDate: null,
            finishDate: null,
            timeFrame: 'current',
          },
        },
      ],
    };
    expect(adoIterationListSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips iteration work items', () => {
    const payload = {
      workItemRelations: [
        { rel: null, source: null, target: { id: 4211 } },
        {
          rel: 'System.LinkTypes.Hierarchy-Forward',
          source: { id: 4211 },
          target: { id: 4212 },
        },
      ],
    };
    expect(adoIterationWorkItemsSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips a board and exposes its column field name', () => {
    const payload = {
      id: BOARD_ID,
      name: 'Stories',
      columns: [
        {
          id: 'col-1',
          name: 'In Review',
          itemLimit: 5,
          stateMappings: { 'User Story': 'Active' },
          columnType: 'inProgress',
          isSplit: true,
        },
      ],
      fields: {
        columnField: { referenceName: kanbanColumnFieldName(BOARD_ID) },
        doneField: { referenceName: kanbanColumnDoneFieldName(BOARD_ID) },
      },
    };
    const board = adoBoardSchema.parse(payload);
    expect(board.columns[0]?.isSplit).toBe(true);
    expect(board.fields?.doneField?.referenceName).toContain('.Column.Done');
  });

  it('rejects a board column set that is not an array', () => {
    const result = adoBoardSchema.safeParse({
      id: BOARD_ID,
      name: 'Stories',
      columns: {},
    });
    expect(result.success).toBe(false);
  });

  it('round-trips taskboard columns', () => {
    const payload = {
      columns: [
        {
          id: 'tc-1',
          name: 'In Progress',
          order: 1,
          mappings: [{ state: 'Active', workItemType: 'Task' }],
        },
      ],
      isCustomized: true,
      isValid: true,
    };
    expect(adoTaskboardColumnsSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips capacities and team days off', () => {
    const capacities = {
      count: 1,
      value: [
        {
          teamMember: { id: 'u1', descriptor: 'aad.YWJj' },
          activities: [{ capacityPerDay: 6, name: 'Development' }],
          daysOff: [{ start: '2026-09-21', end: '2026-09-22' }],
        },
      ],
    };
    expect(adoCapacityListSchema.parse(capacities)).toEqual(capacities);
    const daysOff = { daysOff: [{ start: '2026-09-25', end: '2026-09-25' }] };
    expect(adoTeamSettingsDaysOffSchema.parse(daysOff)).toEqual(daysOff);
  });

  it('round-trips a work item batch response', () => {
    const payload = {
      count: 1,
      value: [
        {
          id: 4211,
          rev: 7,
          fields: {
            'System.Title': 'Wire the board',
            'System.State': 'Active',
          },
        },
      ],
    };
    expect(adoWorkItemListSchema.parse(payload)).toEqual(payload);
  });

  it('caps a batch request at the service limit', () => {
    const ids = Array.from(
      { length: ADO_WORK_ITEM_BATCH_LIMIT + 1 },
      (_unused, index) => index + 1,
    );
    expect(adoWorkItemBatchRequestSchema.safeParse({ ids }).success).toBe(
      false,
    );
    expect(
      adoWorkItemBatchRequestSchema.safeParse({ ids: ids.slice(1) }).success,
    ).toBe(true);
  });

  it('round-trips a flat WIQL result', () => {
    const payload = {
      queryType: 'flat',
      queryResultType: 'workItem',
      asOf: '2026-09-17T08:00:00Z',
      workItems: [{ id: 4211 }],
    };
    expect(adoWiqlResultSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips a workitem.updated hook payload', () => {
    const payload = {
      eventType: 'workitem.updated',
      publisherId: 'tfs',
      resource: {
        id: 9001,
        workItemId: 4211,
        rev: 8,
        revisedBy: { descriptor: 'aad.YW5h' },
        fields: {
          'System.State': { oldValue: 'New', newValue: 'Active' },
        },
      },
      resourceContainers: { project: { id: 'proj-1' } },
    };
    expect(adoWorkItemUpdatedEventSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a hook payload for a different event type', () => {
    const result = adoWorkItemUpdatedEventSchema.safeParse({
      eventType: 'workitem.created',
      resource: { id: 1, workItemId: 2, rev: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('round-trips an error response', () => {
    const payload = {
      message: 'TF401232: Work item 4211 does not exist',
      typeKey: 'WorkItemDoesNotExistException',
      errorCode: 0,
      eventId: 3200,
    };
    expect(adoErrorResponseSchema.parse(payload)).toEqual(payload);
  });
});

describe('rate limit headers', () => {
  it('reads every header, on success as well as on a 429', () => {
    const state = parseAdoRateLimitHeaders(
      {
        'x-ratelimit-remaining': '180',
        'x-ratelimit-limit': '200',
        'x-ratelimit-reset': '1789000000',
        'retry-after': ['30'],
      },
      new Date('2026-09-17T08:00:00Z'),
    );
    expect(state).toEqual({
      remaining: 180,
      limit: 200,
      resetEpochSeconds: 1789000000,
      retryAfterSeconds: 30,
      observedAt: '2026-09-17T08:00:00.000Z',
    });
  });

  it('gives nulls rather than throwing when headers are absent', () => {
    const state = parseAdoRateLimitHeaders({}, new Date(0));
    expect(state.remaining).toBeNull();
    expect(state.retryAfterSeconds).toBeNull();
  });
});

describe('the WEF board column field', () => {
  it('builds the field key from a board id', () => {
    expect(boardIdToFieldToken(BOARD_ID)).toBe(
      '4A1B2C3D4E5F60718293A4B5C6D7E8F9',
    );
    expect(kanbanColumnFieldName(BOARD_ID)).toBe(
      'WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column',
    );
    expect(kanbanColumnDoneFieldName(BOARD_ID)).toBe(
      'WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column.Done',
    );
  });

  it('reads the column and the split-column Done flag', () => {
    const fields = {
      [kanbanColumnFieldName(BOARD_ID)]: 'In Review',
      [kanbanColumnDoneFieldName(BOARD_ID)]: true,
    };
    expect(readKanbanColumn(fields, BOARD_ID)).toBe('In Review');
    expect(readKanbanColumnDone(fields, BOARD_ID)).toBe(true);
  });

  it('gives null for a board whose field is absent', () => {
    expect(readKanbanColumn({}, BOARD_ID)).toBeNull();
    expect(readKanbanColumnDone({}, BOARD_ID)).toBeNull();
  });
});

describe('field accessors', () => {
  const fields: Record<string, unknown> = {
    [ADO_FIELDS.title]: 'Wire the board',
    [ADO_FIELDS.state]: '',
    [ADO_FIELDS.remainingWork]: 4.5,
    [ADO_FIELDS.tags]: 'ui; sprint-goal ;',
    [ADO_FIELDS.assignedTo]: {
      descriptor: 'aad.YWJj',
      displayName: 'A. Person',
    },
  };

  it('reads strings, treating empty as absent', () => {
    expect(readStringField(fields, ADO_FIELDS.title)).toBe('Wire the board');
    expect(readStringField(fields, ADO_FIELDS.state)).toBeNull();
    expect(readStringField(fields, 'System.Missing')).toBeNull();
  });

  it('reads numbers and rejects numeric strings', () => {
    expect(readNumberField(fields, ADO_FIELDS.remainingWork)).toBe(4.5);
    expect(readNumberField(fields, ADO_FIELDS.title)).toBeNull();
  });

  it('splits tags and drops the blanks', () => {
    expect(readTagsField(fields)).toEqual(['ui', 'sprint-goal']);
    expect(readTagsField({})).toEqual([]);
  });

  it('reads an identity, or null when the shape is wrong', () => {
    expect(readIdentityField(fields, ADO_FIELDS.assignedTo)?.descriptor).toBe(
      'aad.YWJj',
    );
    expect(readIdentityField(fields, ADO_FIELDS.title)).toBeNull();
  });
});
