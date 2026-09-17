/**
 * The grid's shaping rules, which are the ones a reader has to trust:
 * columns in configured order, the unmapped column visible, and the
 * unassigned lane pinned at the top whatever the snapshot's order says.
 */
import { describe, expect, it } from 'vitest';
import { UNASSIGNED_LANE_ID, UNMAPPED_COLUMN_ID } from '@eg/shared';
import {
  FIXTURE_BOARD_ID,
  FIXTURE_COLUMNS,
  makeBoardCard,
  makeSwimlane,
  makeUnassignedSwimlane,
} from '../api';
import {
  buildColumnList,
  countCardsByColumn,
  orderSwimlanes,
  showsMixedCadence,
} from './layout';

describe('buildColumnList', () => {
  it('keeps the configured order and adds no unmapped column', () => {
    const columns = buildColumnList(
      FIXTURE_BOARD_ID,
      [...FIXTURE_COLUMNS].reverse(),
      [makeBoardCard()],
      [],
    );
    expect(columns.map((column) => column.id)).toEqual([
      'col-todo',
      'col-doing',
      'col-review',
      'col-done',
    ]);
  });

  it('appends an unmapped column when a card is stranded in one', () => {
    const columns = buildColumnList(
      FIXTURE_BOARD_ID,
      FIXTURE_COLUMNS,
      [makeBoardCard({ canonicalColumnId: UNMAPPED_COLUMN_ID })],
      [],
    );
    expect(columns.at(-1)?.id).toBe(UNMAPPED_COLUMN_ID);
    expect(columns.at(-1)?.name).toBe('Unmapped');
  });

  it('appends it for a reported mapping gap even with no card yet', () => {
    const columns = buildColumnList(
      FIXTURE_BOARD_ID,
      FIXTURE_COLUMNS,
      [],
      [
        {
          projectId: 'Delivery',
          teamId: 'team-data',
          teamName: 'Data and AI',
          sourceColumn: 'In Review',
          cardCount: 0,
        },
      ],
    );
    expect(columns).toHaveLength(FIXTURE_COLUMNS.length + 1);
  });
});

describe('orderSwimlanes', () => {
  it('pins the unassigned lane first however the snapshot ordered it', () => {
    const lanes = orderSwimlanes(
      [
        makeSwimlane({ id: 'lane-ana', label: 'Ana Ilic', order: 0 }),
        { ...makeUnassignedSwimlane(), order: 9 },
      ],
      [],
      'person',
    );
    expect(lanes[0]?.id).toBe(UNASSIGNED_LANE_ID);
    expect(lanes[1]?.id).toBe('lane-ana');
  });

  it('adds an unassigned lane when a card would otherwise vanish', () => {
    const lanes = orderSwimlanes(
      [makeSwimlane()],
      [makeBoardCard({ workItemId: 4, assignedTo: null, remainingWork: 3 })],
      'person',
    );
    expect(lanes[0]?.id).toBe(UNASSIGNED_LANE_ID);
    expect(lanes[0]?.cardCount).toBe(1);
    expect(lanes[0]?.remainingWorkHours).toBe(3);
  });
});

describe('countCardsByColumn', () => {
  it('gives every column a count, including the empty ones', () => {
    const counts = countCardsByColumn(
      [makeBoardCard(), makeBoardCard({ workItemId: 2 })],
      FIXTURE_COLUMNS,
    );
    expect(counts.get('col-doing')).toBe(2);
    expect(counts.get('col-done')).toBe(0);
  });
});

describe('showsMixedCadence', () => {
  it('is on only when every team runs its own current sprint', () => {
    expect(showsMixedCadence({ mode: 'each-team-current' })).toBe(true);
    expect(
      showsMixedCadence({ mode: 'named-iteration', iterationPath: 'S1' }),
    ).toBe(false);
  });
});
