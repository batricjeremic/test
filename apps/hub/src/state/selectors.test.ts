import { describe, expect, it } from 'vitest';
import { UNASSIGNED_LANE_ID } from '@eg/shared';
import {
  FIXTURE_COLUMNS,
  makeBoardCard,
  makeSwimlane,
  makeUnassignedSwimlane,
} from '../api';
import {
  buildBoardMatrix,
  groupCardsBySwimlane,
  swimlaneIdForCard,
} from './selectors';
import { describeMoveFailure } from './toasts';

const swimlanes = [
  makeUnassignedSwimlane(),
  makeSwimlane({ id: 'lane-ana', personDescriptor: 'aad.ana' }),
  makeSwimlane({
    id: 'lane-team-dev',
    kind: 'team',
    personDescriptor: null,
    teamId: 'team-dev',
    label: 'Dev',
  }),
];

describe('swimlaneIdForCard', () => {
  it('puts a person’s card in their lane', () => {
    expect(swimlaneIdForCard(makeBoardCard(), 'person', swimlanes)).toBe(
      'lane-ana',
    );
  });

  it('pins an unassigned card to the unassigned lane', () => {
    expect(
      swimlaneIdForCard(
        makeBoardCard({ assignedTo: null }),
        'person',
        swimlanes,
      ),
    ).toBe(UNASSIGNED_LANE_ID);
  });

  it('falls back to the unassigned lane for a person out of scope', () => {
    expect(
      swimlaneIdForCard(
        makeBoardCard({
          assignedTo: { descriptor: 'aad.someone', displayName: 'Someone' },
        }),
        'person',
        swimlanes,
      ),
    ).toBe(UNASSIGNED_LANE_ID);
  });

  it('groups by team when asked', () => {
    expect(swimlaneIdForCard(makeBoardCard(), 'team', swimlanes)).toBe(
      'lane-team-dev',
    );
  });
});

describe('grouping', () => {
  it('gives every lane an entry, even an empty one', () => {
    const byLane = groupCardsBySwimlane([makeBoardCard()], swimlanes, 'person');
    expect([...byLane.keys()]).toEqual([
      UNASSIGNED_LANE_ID,
      'lane-ana',
      'lane-team-dev',
    ]);
    expect(byLane.get(UNASSIGNED_LANE_ID)).toEqual([]);
    expect(byLane.get('lane-ana')).toHaveLength(1);
  });

  it('builds a lane-by-column matrix in snapshot order', () => {
    const cards = [
      makeBoardCard({ workItemId: 1, canonicalColumnId: 'col-doing' }),
      makeBoardCard({ workItemId: 2, canonicalColumnId: 'col-doing' }),
      makeBoardCard({ workItemId: 3, canonicalColumnId: 'col-done' }),
    ];
    const matrix = buildBoardMatrix(
      cards,
      swimlanes,
      FIXTURE_COLUMNS,
      'person',
    );
    const lane = matrix.get('lane-ana');

    expect(lane?.get('col-doing')?.map((card) => card.workItemId)).toEqual([
      1, 2,
    ]);
    expect(lane?.get('col-done')?.map((card) => card.workItemId)).toEqual([3]);
    expect(lane?.get('col-todo')).toEqual([]);
  });
});

describe('describeMoveFailure', () => {
  it('names the field and offers the work item form on a rule violation', () => {
    const content = describeMoveFailure({
      reason: 'rule-violation',
      message: '',
      field: 'Microsoft.VSTS.Common.Activity',
      fieldDisplayName: 'Activity',
      targetState: 'Active',
      workItemUrl:
        'https://dev.azure.com/expertgroup/Delivery/_workitems/edit/1',
    });

    expect(content.title).toContain('Activity');
    expect(content.action?.label).toBe('Open work item');
    expect(content.action?.href).toContain('_workitems/edit/1');
  });

  it('names the allowed next states on a forbidden transition', () => {
    const content = describeMoveFailure({
      reason: 'transition-not-allowed',
      message: '',
      fromState: 'New',
      toState: 'Closed',
      allowedStates: ['Active', 'Resolved'],
    });

    expect(content.message).toContain('Active or Resolved');
  });

  it('names who moved the card on a revision conflict', () => {
    const content = describeMoveFailure({
      reason: 'revision-conflict',
      message: '',
      currentRev: 9,
      currentCanonicalColumnId: 'col-done',
      currentColumnName: 'Done',
      changedBy: { descriptor: 'aad.ana', displayName: 'Ana' },
      changedAt: null,
    });

    expect(content.message).toContain('Ana');
    expect(content.message).toContain('Done');
  });
});
