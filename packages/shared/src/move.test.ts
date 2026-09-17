import { describe, expect, it } from 'vitest';
import { auditEntrySchema, newAuditEntrySchema } from './audit.js';
import {
  MOVE_FAILURE_REASONS,
  moveFailureSchema,
  moveRequestSchema,
  moveResultSchema,
} from './move.js';

const card = {
  workItemId: 4211,
  project: 'Delivery',
  teamId: 'team-dev',
  iterationId: 'iter-24',
  title: 'Wire the aggregated board',
  type: 'User Story',
  assignedTo: null,
  state: 'Active',
  sourceColumn: 'In Review',
  canonicalColumnId: 'col-review',
  remainingWork: null,
  tags: [],
  rev: 8,
};

describe('moveRequestSchema', () => {
  it('round-trips a drag', () => {
    const request = {
      boardId: 'board-1',
      workItemId: 4211,
      rev: 7,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-review',
    };
    expect(moveRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects a request without the rev the user was looking at', () => {
    const result = moveRequestSchema.safeParse({
      boardId: 'board-1',
      workItemId: 4211,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-review',
    });
    expect(result.success).toBe(false);
  });
});

describe('moveFailureSchema', () => {
  it('covers the spec write-failure table row for row', () => {
    expect([...MOVE_FAILURE_REASONS]).toEqual([
      'revision-conflict',
      'rule-violation',
      'transition-not-allowed',
      'permission-denied',
      'mapping-missing',
      'service-unavailable',
    ]);
  });

  it('round-trips a revision conflict with who moved it and where', () => {
    const failure = {
      reason: 'revision-conflict' as const,
      message: 'Ana moved this to Done a moment ago',
      currentRev: 9,
      currentCanonicalColumnId: 'col-done',
      currentColumnName: 'Done',
      changedBy: { descriptor: 'aad.YW5h', displayName: 'Ana' },
      changedAt: '2026-09-17T08:00:00Z',
    };
    expect(moveFailureSchema.parse(failure)).toEqual(failure);
  });

  it('round-trips a rule violation naming the field and the form', () => {
    const failure = {
      reason: 'rule-violation' as const,
      message: 'Activity is required before moving to Active',
      field: 'Microsoft.VSTS.Common.Activity',
      fieldDisplayName: 'Activity',
      targetState: 'Active',
      workItemUrl: 'https://dev.azure.com/eg/_workitems/edit/4211',
    };
    expect(moveFailureSchema.parse(failure)).toEqual(failure);
  });

  it('rejects a rule violation whose work item link is not a URL', () => {
    const result = moveFailureSchema.safeParse({
      reason: 'rule-violation',
      message: 'Activity is required',
      field: 'Microsoft.VSTS.Common.Activity',
      fieldDisplayName: 'Activity',
      targetState: 'Active',
      workItemUrl: '/_workitems/edit/4211',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a transition failure listing the allowed states', () => {
    const failure = {
      reason: 'transition-not-allowed' as const,
      message: 'New can only move to Active or Removed',
      fromState: 'New',
      toState: 'Done',
      allowedStates: ['Active', 'Removed'],
    };
    expect(moveFailureSchema.parse(failure)).toEqual(failure);
  });

  it('round-trips permission, mapping and service failures', () => {
    const denied = {
      reason: 'permission-denied' as const,
      message: 'You cannot write in Data and AI',
      projectId: 'proj-2',
      projectName: 'Data and AI',
    };
    const unmapped = {
      reason: 'mapping-missing' as const,
      message: 'In Review is not mapped for Data and AI',
      projectId: 'proj-2',
      teamId: 'team-data',
      teamName: 'Data and AI',
      canonicalColumnId: 'col-review',
      canonicalColumnName: 'In Review',
    };
    const busy = {
      reason: 'service-unavailable' as const,
      message: 'Azure DevOps is busy. Your change was not saved.',
      attempts: 3,
      retryAfterSeconds: 12,
    };
    expect(moveFailureSchema.parse(denied)).toEqual(denied);
    expect(moveFailureSchema.parse(unmapped)).toEqual(unmapped);
    expect(moveFailureSchema.parse(busy)).toEqual(busy);
  });

  it('rejects a reason outside the table', () => {
    const result = moveFailureSchema.safeParse({
      reason: 'network-wobble',
      message: 'nope',
    });
    expect(result.success).toBe(false);
  });
});

describe('moveResultSchema', () => {
  it('round-trips an applied move carrying the new rev', () => {
    const applied = {
      status: 'applied' as const,
      workItemId: 4211,
      card,
      stateChanged: true,
    };
    const parsed = moveResultSchema.parse(applied);
    expect(parsed).toEqual(applied);
    expect(parsed.status === 'applied' && parsed.card.rev).toBe(8);
  });

  it('round-trips a failure with the refreshed card to snap back to', () => {
    const failed = {
      status: 'failed' as const,
      workItemId: 4211,
      failure: {
        reason: 'revision-conflict' as const,
        message: 'Ana moved this to Done a moment ago',
        currentRev: 9,
        currentCanonicalColumnId: 'col-done',
        currentColumnName: 'Done',
        changedBy: null,
        changedAt: null,
      },
      card: { ...card, rev: 9 },
    };
    expect(moveResultSchema.parse(failed)).toEqual(failed);
  });

  it('rejects a failure with no reason attached', () => {
    const result = moveResultSchema.safeParse({
      status: 'failed',
      workItemId: 4211,
      card: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('auditEntrySchema', () => {
  const entry = {
    id: 'audit-1',
    boardId: 'board-1',
    actor: 'aad.YWJj',
    workItemId: 4211,
    from: 'col-doing',
    to: 'col-review',
    result: { outcome: 'success' as const, newRev: 8, stateChanged: false },
    timestamp: '2026-09-17T08:00:00Z',
    traceId: 'trace-1',
  };

  it('round-trips a successful attempt', () => {
    expect(auditEntrySchema.parse(entry)).toEqual(entry);
  });

  it('round-trips a failed attempt, which is still written', () => {
    const failed = {
      ...entry,
      result: {
        outcome: 'failure' as const,
        failure: {
          reason: 'service-unavailable' as const,
          message: 'busy',
          attempts: 3,
          retryAfterSeconds: null,
        },
      },
    };
    expect(auditEntrySchema.parse(failed)).toEqual(failed);
  });

  it('omits the id on a new entry', () => {
    const { id: _id, ...rest } = entry;
    expect(newAuditEntrySchema.parse(rest)).toEqual(rest);
    expect(auditEntrySchema.safeParse(rest).success).toBe(false);
  });
});
