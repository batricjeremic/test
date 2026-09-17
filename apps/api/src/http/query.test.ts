import { EMPTY_BOARD_FILTER_SET } from '@eg/shared';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import { parseBoardIdParam, parseSnapshotQuery } from './query.js';

describe('parseSnapshotQuery', () => {
  it('defaults to every team s current sprint, unfiltered', () => {
    expect(parseSnapshotQuery({})).toEqual({
      alignment: { mode: 'each-team-current' },
      grouping: null,
      filters: EMPTY_BOARD_FILTER_SET,
    });
  });

  it('reads the spec s ?window=current', () => {
    expect(parseSnapshotQuery({ window: 'current' }).alignment).toEqual({
      mode: 'each-team-current',
    });
  });

  it('reads a date window', () => {
    expect(
      parseSnapshotQuery({
        window: 'date-window',
        start: '2026-09-01',
        end: '2026-09-30',
      }).alignment,
    ).toEqual({
      mode: 'date-window',
      window: { start: '2026-09-01', end: '2026-09-30' },
    });
  });

  it('refuses a date window with no dates', () => {
    expect(() => parseSnapshotQuery({ window: 'date-window' })).toThrow(
      ValidationError,
    );
  });

  it('reads a named iteration', () => {
    expect(
      parseSnapshotQuery({
        window: 'named-iteration',
        iterationPath: 'Delivery\\Sprint 7',
      }).alignment,
    ).toEqual({ mode: 'named-iteration', iterationPath: 'Delivery\\Sprint 7' });
  });

  it('takes a filter either repeated or comma separated', () => {
    const filters = parseSnapshotQuery({
      projectIds: 'Delivery,Data',
      teamIds: ['team-dev', 'team-data'],
      tags: ' risk , ',
      unassignedOnly: 'true',
    }).filters;

    expect(filters.projectIds).toEqual(['Delivery', 'Data']);
    expect(filters.teamIds).toEqual(['team-dev', 'team-data']);
    expect(filters.tags).toEqual(['risk']);
    expect(filters.unassignedOnly).toBe(true);
  });

  it('refuses a grouping it does not know', () => {
    expect(() => parseSnapshotQuery({ grouping: 'by-mood' })).toThrow(
      ValidationError,
    );
  });
});

describe('parseBoardIdParam', () => {
  it('takes a non-empty id and nothing else', () => {
    expect(parseBoardIdParam({ boardId: 'board-1' })).toBe('board-1');
    expect(() => parseBoardIdParam({ boardId: '' })).toThrow(ValidationError);
    expect(() => parseBoardIdParam({})).toThrow(ValidationError);
  });
});
