import { EMPTY_BOARD_FILTER_SET } from '@eg/shared';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import { parseBoardIdParam, parseSnapshotQuery } from './query.js';

/**
 * These used to be written against this file's OWN parameter names —
 * `window`, `projectIds`, `workItemTypes` — none of which the hub has
 * ever sent. The suite was green while every filter but tags and states
 * was dead on the wire, and while the alignment picker did nothing at
 * all. The names below are the ones `encodeBoardQuery` actually writes.
 */
describe('parseSnapshotQuery', () => {
  it('defaults to every team s current sprint, unfiltered', () => {
    expect(parseSnapshotQuery({})).toEqual({
      alignment: { mode: 'each-team-current' },
      grouping: null,
      filters: EMPTY_BOARD_FILTER_SET,
    });
  });

  it('reads ?mode=each-team-current', () => {
    expect(parseSnapshotQuery({ mode: 'each-team-current' }).alignment).toEqual(
      { mode: 'each-team-current' },
    );
  });

  it('reads a date window', () => {
    expect(
      parseSnapshotQuery({
        mode: 'date-window',
        start: '2026-09-01',
        end: '2026-09-30',
      }).alignment,
    ).toEqual({
      mode: 'date-window',
      window: { start: '2026-09-01', end: '2026-09-30' },
    });
  });

  // A request is not a bookmark: a caller's mistake gets a 400 rather
  // than a silent answer to a question nobody asked. The hub's own URL
  // decoder is lenient on purpose; see decodeBoardQuery in @eg/shared.
  it('refuses a date window with no dates', () => {
    expect(() => parseSnapshotQuery({ mode: 'date-window' })).toThrow(
      ValidationError,
    );
  });

  it('reads a named iteration', () => {
    expect(
      parseSnapshotQuery({
        mode: 'named-iteration',
        iteration: 'Delivery\\Sprint 7',
      }).alignment,
    ).toEqual({
      mode: 'named-iteration',
      iterationPath: 'Delivery\\Sprint 7',
    });
  });

  it('takes a filter either repeated or comma separated', () => {
    const filters = parseSnapshotQuery({
      projects: 'Delivery,Data',
      teams: ['team-dev', 'team-data'],
      types: 'User Story',
      tags: ' risk , ',
      unassigned: '1',
    }).filters;

    expect(filters.projectIds).toEqual(['Delivery', 'Data']);
    expect(filters.teamIds).toEqual(['team-dev', 'team-data']);
    expect(filters.workItemTypes).toEqual(['User Story']);
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
