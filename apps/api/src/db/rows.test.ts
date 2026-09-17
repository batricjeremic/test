import { describe, expect, it } from 'vitest';
import { InternalError } from '../errors.js';
import {
  auditResultColumns,
  toAuditEntry,
  toBoardDefinition,
  toBoardSource,
  toCanonicalColumn,
  toColumnMapping,
  toPersonOverride,
  auditEntryRowSchema,
  canonicalColumnRowSchema,
} from './rows.js';

describe('row to DTO mapping', () => {
  it('maps a board definition row onto the shared DTO', () => {
    expect(
      toBoardDefinition({
        id: 'b1',
        name: 'Delivery — all divisions',
        org_id: 'expertgroup',
        default_grouping: 'person',
        owner_descriptor: 'aad.owner',
      }),
    ).toEqual({
      id: 'b1',
      name: 'Delivery — all divisions',
      orgId: 'expertgroup',
      defaultGrouping: 'person',
      ownerDescriptor: 'aad.owner',
    });
  });

  it('maps a board source row', () => {
    expect(
      toBoardSource({
        board_id: 'b1',
        project_id: 'p1',
        team_id: 't1',
        backlog_level: 'Microsoft.RequirementCategory',
      }),
    ).toEqual({
      boardId: 'b1',
      projectId: 'p1',
      teamId: 't1',
      backlogLevel: 'Microsoft.RequirementCategory',
    });
  });

  it('accepts an integer column that arrives as a string', () => {
    const row = canonicalColumnRowSchema.parse({
      id: 'c1',
      board_id: 'b1',
      name: 'In Review',
      order: '2',
      state_category: 'InProgress',
    });
    expect(toCanonicalColumn(row)).toEqual({
      id: 'c1',
      boardId: 'b1',
      name: 'In Review',
      order: 2,
      stateCategory: 'InProgress',
    });
  });

  it('rejects a state category the shared schema does not allow', () => {
    expect(() =>
      toCanonicalColumn({
        id: 'c1',
        board_id: 'b1',
        name: 'In Review',
        order: 0,
        state_category: 'Somewhere',
      }),
    ).toThrow(InternalError);
  });

  it('keeps a null target state as "column only"', () => {
    expect(
      toColumnMapping({
        board_id: 'b1',
        team_id: 't1',
        source_column_id: 'In Review',
        canonical_column_id: 'c1',
        target_state: null,
      }).targetState,
    ).toBeNull();
  });

  it('maps a person override row', () => {
    expect(
      toPersonOverride({
        board_id: 'b1',
        descriptor: 'aad.person',
        display_name: 'Contractor',
        hidden: true,
      }),
    ).toEqual({
      boardId: 'b1',
      descriptor: 'aad.person',
      displayName: 'Contractor',
      hidden: true,
    });
  });

  it('normalises a timestamptz Date into an ISO instant', () => {
    const row = auditEntryRowSchema.parse({
      id: 'a1',
      board_id: 'b1',
      actor: 'aad.actor',
      work_item_id: '1234',
      from_column_id: 'c1',
      to_column_id: 'c2',
      result: { outcome: 'success', newRev: 8, stateChanged: true },
      occurred_at: new Date('2026-09-17T08:00:00.000Z'),
      trace_id: 'trace-1',
    });
    const entry = toAuditEntry(row);
    expect(entry.timestamp).toBe('2026-09-17T08:00:00.000Z');
    expect(entry.workItemId).toBe(1234);
    expect(entry.from).toBe('c1');
    expect(entry.to).toBe('c2');
  });

  it('accepts a timestamp that arrives as a string', () => {
    const row = auditEntryRowSchema.parse({
      id: 'a1',
      board_id: 'b1',
      actor: 'aad.actor',
      work_item_id: 1,
      from_column_id: 'c1',
      to_column_id: 'c2',
      result: { outcome: 'success', newRev: 1, stateChanged: false },
      occurred_at: '2026-09-17T08:00:00+02:00',
      trace_id: 'trace-1',
    });
    expect(toAuditEntry(row).timestamp).toBe('2026-09-17T06:00:00.000Z');
  });

  it('rejects an audit row whose stored result is not a MoveResult', () => {
    expect(() =>
      toAuditEntry({
        id: 'a1',
        board_id: 'b1',
        actor: 'aad.actor',
        work_item_id: 1,
        from_column_id: 'c1',
        to_column_id: 'c2',
        result: { outcome: 'maybe' },
        occurred_at: '2026-09-17T08:00:00.000Z',
        trace_id: 'trace-1',
      }),
    ).toThrow(InternalError);
  });
});

describe('auditResultColumns', () => {
  it('denormalises a success', () => {
    expect(
      auditResultColumns({
        outcome: 'success',
        newRev: 12,
        stateChanged: true,
      }),
    ).toEqual({
      outcome: 'success',
      newRev: 12,
      stateChanged: true,
      failureReason: null,
    });
  });

  it('denormalises a failure, keeping the reason queryable', () => {
    expect(
      auditResultColumns({
        outcome: 'failure',
        failure: {
          reason: 'revision-conflict',
          message: 'Ana moved this to Done a moment ago',
          currentRev: 9,
          currentCanonicalColumnId: 'c3',
          currentColumnName: 'Done',
          changedBy: null,
          changedAt: null,
        },
      }),
    ).toEqual({
      outcome: 'failure',
      newRev: null,
      stateChanged: null,
      failureReason: 'revision-conflict',
    });
  });
});
