import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  ADO_SERVICE_HOOK_ACTION_ID,
  ADO_SERVICE_HOOK_CONSUMER_ID,
  ADO_SERVICE_HOOK_PUBLISHER_ID,
  ADO_WORK_ITEM_UPDATED_EVENT,
  buildColumnMovePatch,
  buildReassignPatch,
  buildTaskboardUpdate,
  buildWorkItemUpdatedSubscription,
  resolveColumnFieldNames,
  revisionTestOperation,
} from './patch.js';
import { adoJsonPatchDocumentSchema } from './types.js';

const BOARD_ID = '4a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const COLUMN_FIELD =
  '/fields/WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column';
const DONE_FIELD = `${COLUMN_FIELD}.Done`;

describe('buildColumnMovePatch', () => {
  it('produces the exact document for a move without a targetState', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 12,
      column: 'In Review',
    });
    expect(patch).toEqual([
      { op: 'test', path: '/rev', value: 12 },
      { op: 'add', path: COLUMN_FIELD, value: 'In Review' },
    ]);
  });

  it('produces the exact document for a move with a targetState', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 12,
      column: 'In Review',
      targetState: 'Active',
    });
    expect(patch).toEqual([
      { op: 'test', path: '/rev', value: 12 },
      { op: 'add', path: COLUMN_FIELD, value: 'In Review' },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
  });

  it('writes column and state in one document so they cannot diverge', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 3,
      column: 'Done',
      targetState: 'Closed',
    });
    const paths = patch.map((operation) => operation.path);
    expect(paths).toContain(COLUMN_FIELD);
    expect(paths).toContain('/fields/System.State');
    expect(patch).toHaveLength(3);
  });

  it('always opens with the rev test operation', () => {
    for (const targetState of [null, 'Active']) {
      const patch = buildColumnMovePatch({
        boardId: BOARD_ID,
        rev: 41,
        column: 'Doing',
        targetState,
      });
      expect(patch[0]).toEqual({ op: 'test', path: '/rev', value: 41 });
    }
  });

  it('writes the Done companion for a split column', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 7,
      column: 'In Review',
      done: true,
      targetState: 'Active',
    });
    expect(patch).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'add', path: COLUMN_FIELD, value: 'In Review' },
      { op: 'add', path: DONE_FIELD, value: true },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
  });

  it('omits the Done field when the column is not split', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 7,
      column: 'In Review',
      done: null,
    });
    expect(patch.map((operation) => operation.path)).not.toContain(DONE_FIELD);
  });

  it('omits the state write when targetState is an empty string', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 1,
      column: 'Doing',
      targetState: '',
    });
    expect(patch).toHaveLength(2);
  });

  it('prefers the board document field names over the derived ones', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 2,
      column: 'Doing',
      done: false,
      boardFields: {
        columnField: { referenceName: 'WEF_OTHER_Kanban.Column' },
        doneField: { referenceName: 'WEF_OTHER_Kanban.Column.Done' },
      },
    });
    expect(patch[1]?.path).toBe('/fields/WEF_OTHER_Kanban.Column');
    expect(patch[2]?.path).toBe('/fields/WEF_OTHER_Kanban.Column.Done');
  });

  it('is a valid JSON Patch document', () => {
    const patch = buildColumnMovePatch({
      boardId: BOARD_ID,
      rev: 9,
      column: 'Done',
      done: true,
      targetState: 'Closed',
    });
    expect(adoJsonPatchDocumentSchema.parse(patch)).toEqual(patch);
  });

  it('rejects a non-integer or negative rev', () => {
    expect(() =>
      buildColumnMovePatch({ boardId: BOARD_ID, rev: 1.5, column: 'Doing' }),
    ).toThrow(ValidationError);
    expect(() =>
      buildColumnMovePatch({ boardId: BOARD_ID, rev: -1, column: 'Doing' }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty board id or column', () => {
    expect(() =>
      buildColumnMovePatch({ boardId: '', rev: 1, column: 'Doing' }),
    ).toThrow(ValidationError);
    expect(() =>
      buildColumnMovePatch({ boardId: BOARD_ID, rev: 1, column: '' }),
    ).toThrow(ValidationError);
  });
});

describe('resolveColumnFieldNames', () => {
  it('derives WEF names from the board id when no document is held', () => {
    expect(resolveColumnFieldNames(BOARD_ID)).toEqual({
      column: 'WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column',
      done: 'WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column.Done',
    });
  });
});

describe('revisionTestOperation', () => {
  it('is the concurrency guard on its own', () => {
    expect(revisionTestOperation(5)).toEqual([
      { op: 'test', path: '/rev', value: 5 },
    ]);
  });
});

describe('buildReassignPatch', () => {
  it('guards the rev and writes System.AssignedTo', () => {
    expect(
      buildReassignPatch({ rev: 4, assignee: 'ana@example.test' }),
    ).toEqual([
      { op: 'test', path: '/rev', value: 4 },
      {
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: 'ana@example.test',
      },
    ]);
  });

  it('removes the field when the assignee is null', () => {
    expect(buildReassignPatch({ rev: 4, assignee: null })).toEqual([
      { op: 'test', path: '/rev', value: 4 },
      { op: 'remove', path: '/fields/System.AssignedTo' },
    ]);
  });
});

describe('buildTaskboardUpdate', () => {
  it('produces the newColumn body', () => {
    expect(buildTaskboardUpdate('In Progress')).toEqual({
      newColumn: 'In Progress',
    });
  });

  it('rejects an empty column name', () => {
    expect(() => buildTaskboardUpdate('')).toThrow(ValidationError);
  });
});

describe('buildWorkItemUpdatedSubscription', () => {
  it('subscribes one project to workitem.updated', () => {
    const request = buildWorkItemUpdatedSubscription({
      projectId: 'proj-1',
      webhookUrl: 'https://board.example.test/hooks/workitem',
    });
    expect(request.publisherId).toBe(ADO_SERVICE_HOOK_PUBLISHER_ID);
    expect(request.eventType).toBe(ADO_WORK_ITEM_UPDATED_EVENT);
    expect(request.consumerId).toBe(ADO_SERVICE_HOOK_CONSUMER_ID);
    expect(request.consumerActionId).toBe(ADO_SERVICE_HOOK_ACTION_ID);
    expect(request.publisherInputs).toEqual({ projectId: 'proj-1' });
    expect(request.consumerInputs['url']).toBe(
      'https://board.example.test/hooks/workitem',
    );
  });

  it('rejects a webhook URL that is not absolute', () => {
    expect(() =>
      buildWorkItemUpdatedSubscription({
        projectId: 'proj-1',
        webhookUrl: '/hooks/workitem',
      }),
    ).toThrow(ValidationError);
  });
});
