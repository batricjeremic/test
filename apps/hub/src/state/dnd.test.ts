import { describe, expect, it } from 'vitest';
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import { makeBoardCard, makeBoardTeamView } from '../api';
import type { CardDragData, ColumnDropData } from '../types';
import { buildCardDragData, evaluateDrop, isCardDragData } from './dnd';

const drop = (
  canonicalColumnId: string,
  swimlaneId = 'lane-ana',
): ColumnDropData => ({ kind: 'column', canonicalColumnId, swimlaneId });

function drag(overrides: Partial<CardDragData> = {}): CardDragData {
  return {
    ...buildCardDragData(makeBoardCard(), makeBoardTeamView(), 'lane-ana'),
    ...overrides,
  };
}

describe('drag payloads', () => {
  it('recognises its own payload and nothing else', () => {
    expect(isCardDragData(drag())).toBe(true);
    expect(isCardDragData({ kind: 'column' })).toBe(false);
    expect(isCardDragData(null)).toBe(false);
    expect(isCardDragData(undefined)).toBe(false);
  });

  it('carries the rev, the team and the columns the team is mapped to', () => {
    const data = buildCardDragData(
      makeBoardCard({ rev: 11 }),
      makeBoardTeamView(),
      'lane-ana',
    );
    expect(data.rev).toBe(11);
    expect(data.teamId).toBe('team-dev');
    expect(data.allowedCanonicalColumnIds).toContain('col-done');
    expect(data.writable).toBe(true);
  });

  it('marks a card from a team with no view as not writable', () => {
    const data = buildCardDragData(makeBoardCard(), null, 'lane-ana');
    expect(data.writable).toBe(false);
    expect(data.allowedCanonicalColumnIds).toEqual([]);
  });
});

describe('evaluateDrop', () => {
  it('allows a mapped column', () => {
    expect(evaluateDrop(drag(), drop('col-done'))).toEqual({ allowed: true });
  });

  it('refuses a locked card', () => {
    expect(evaluateDrop(drag(), drop('col-done'), { locked: true })).toEqual({
      allowed: false,
      reason: 'card-locked',
    });
  });

  it('refuses a card from a read-only project', () => {
    expect(evaluateDrop(drag({ writable: false }), drop('col-done'))).toEqual({
      allowed: false,
      reason: 'not-writable',
    });
  });

  it('refuses a column the team has no mapping row for', () => {
    expect(
      evaluateDrop(
        drag({ allowedCanonicalColumnIds: ['col-todo', 'col-doing'] }),
        drop('col-done'),
      ),
    ).toEqual({ allowed: false, reason: 'mapping-missing' });
  });

  it('refuses a drop into the unmapped lane', () => {
    expect(evaluateDrop(drag(), drop(UNMAPPED_COLUMN_ID))).toEqual({
      allowed: false,
      reason: 'unmapped-lane',
    });
  });

  it('refuses a drop back on the same cell', () => {
    expect(evaluateDrop(drag(), drop('col-doing', 'lane-ana'))).toEqual({
      allowed: false,
      reason: 'same-column',
    });
  });

  it('allows the same column in a different lane', () => {
    expect(evaluateDrop(drag(), drop('col-doing', 'lane-marko'))).toEqual({
      allowed: true,
    });
  });
});
