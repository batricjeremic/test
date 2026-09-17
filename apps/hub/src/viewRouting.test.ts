/**
 * View routing.
 *
 * Both manifest contributions load this same bundle, so the only thing
 * that decides whether a user lands on the board or on the settings
 * screen is the contribution id. Getting this wrong ships one of the two
 * views to nobody, which no other test would notice.
 */
import { describe, expect, it } from 'vitest';
import { resolveViewId } from './viewRouting';

/** The ids exactly as `vss-extension.json` declares them. */
const BOARD_CONTRIBUTION = 'cross-project-sprint-board-hub';
const ADMIN_CONTRIBUTION = 'cross-project-sprint-board-admin';

describe('resolveViewId', () => {
  it('sends the board contribution to the board', () => {
    expect(resolveViewId(BOARD_CONTRIBUTION, '')).toBe('board');
  });

  it('sends the admin contribution to the settings screen', () => {
    expect(resolveViewId(ADMIN_CONTRIBUTION, '')).toBe('admin');
  });

  it('falls back to the board for an unrecognised contribution', () => {
    expect(resolveViewId('ms.vss-web.some-other-hub', '')).toBe('board');
  });

  it('lets the dev shell override the view from the query string', () => {
    expect(resolveViewId(BOARD_CONTRIBUTION, '?view=admin')).toBe('admin');
    expect(resolveViewId(ADMIN_CONTRIBUTION, '?view=board')).toBe('board');
  });

  it('ignores an override that names no view we have', () => {
    expect(resolveViewId(ADMIN_CONTRIBUTION, '?view=capacity')).toBe('admin');
  });
});
