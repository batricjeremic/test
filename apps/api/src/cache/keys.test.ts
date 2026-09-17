import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE_TTL_SECONDS } from '../config.js';
import {
  CACHE_KEY_TTL_CLASS,
  cacheFingerprint,
  cacheKeys,
  cachePatterns,
  cacheSegment,
  type TeamScope,
} from './keys.js';
import { globToRegExp } from './test-support.js';

const scope: TeamScope = {
  orgId: 'expertgroup',
  projectId: 'proj-dev',
  teamId: 'team-alpha',
};

describe('cacheSegment', () => {
  it('removes separators and glob metacharacters', () => {
    expect(cacheSegment('aad:desc*with?glob')).toBe('aad_desc_with_glob');
  });

  it('never collapses two long distinct ids onto one segment', () => {
    const a = cacheSegment(`${'x'.repeat(200)}a`);
    const b = cacheSegment(`${'x'.repeat(200)}b`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(96);
  });

  it('never produces an empty segment', () => {
    expect(cacheSegment('   ')).toBe('_');
  });
});

describe('cacheFingerprint', () => {
  it('ignores key order, so an equivalent query is one key', () => {
    const left = cacheFingerprint({
      grouping: 'person',
      filters: { tags: [] },
    });
    const right = cacheFingerprint({
      filters: { tags: [] },
      grouping: 'person',
    });
    expect(left).toBe(right);
  });

  it('changes when the query changes', () => {
    expect(cacheFingerprint({ grouping: 'person' })).not.toBe(
      cacheFingerprint({ grouping: 'team' }),
    );
  });
});

describe('cacheKeys', () => {
  it('namespaces every team key by organisation, project and team', () => {
    expect(cacheKeys.teamFieldValues(scope)).toBe(
      'eg:v1:org:expertgroup:project:proj-dev:team:team-alpha:teamfields',
    );
    expect(cacheKeys.capacities(scope, 'iter-7')).toBe(
      'eg:v1:org:expertgroup:project:proj-dev:team:team-alpha' +
        ':iteration:iter-7:capacities',
    );
  });

  it('namespaces board keys by board', () => {
    expect(cacheKeys.boardSnapshot('b1', 'abc')).toBe(
      'eg:v1:board:b1:snapshot:abc',
    );
    expect(cacheKeys.columnMapping('b1')).toBe('eg:v1:board:b1:mapping');
  });

  it('keeps two boards apart', () => {
    expect(cacheKeys.boardSnapshot('b1', 'abc')).not.toBe(
      cacheKeys.boardSnapshot('b2', 'abc'),
    );
  });
});

describe('cachePatterns', () => {
  const matches = (pattern: string, key: string): boolean =>
    globToRegExp(pattern).test(key);

  it('matches the board keys and nothing from another board', () => {
    const pattern = cachePatterns.board('b1');
    expect(matches(pattern, cacheKeys.boardSnapshot('b1', 'f'))).toBe(true);
    expect(matches(pattern, cacheKeys.columnMapping('b1'))).toBe(true);
    expect(matches(pattern, cacheKeys.boardSnapshot('b2', 'f'))).toBe(false);
  });

  it('spares the column mapping when only snapshots are dropped', () => {
    const pattern = cachePatterns.boardSnapshots('b1');
    expect(matches(pattern, cacheKeys.boardSnapshot('b1', 'f'))).toBe(true);
    expect(matches(pattern, cacheKeys.columnMapping('b1'))).toBe(false);
  });

  it('matches team settings entries but not another team', () => {
    const other: TeamScope = { ...scope, teamId: 'team-beta' };
    const entries = cachePatterns.teamIterationEntries(scope);
    const lists = cachePatterns.teamIterationLists(scope);
    expect(matches(entries, cacheKeys.capacities(scope, 'i1'))).toBe(true);
    expect(matches(entries, cacheKeys.daysOff(scope, 'i1'))).toBe(true);
    expect(matches(lists, cacheKeys.teamIterations(scope, 'current'))).toBe(
      true,
    );
    expect(matches(lists, cacheKeys.teamIterations(scope, null))).toBe(true);
    expect(matches(entries, cacheKeys.capacities(other, 'i1'))).toBe(false);
  });

  it('matches board column definitions only', () => {
    const pattern = cachePatterns.teamBoardColumns(scope);
    expect(matches(pattern, cacheKeys.boardColumns(scope, 'ab-1'))).toBe(true);
    expect(matches(pattern, cacheKeys.teamFieldValues(scope))).toBe(false);
  });
});

describe('CACHE_KEY_TTL_CLASS', () => {
  it('names a TTL class for every key builder', () => {
    const builders = Object.keys(cacheKeys).sort();
    expect(Object.keys(CACHE_KEY_TTL_CLASS).sort()).toEqual(builders);
  });

  it("carries the spec's table for each entity class", () => {
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.projects]).toBe(
      86_400,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.teams]).toBe(86_400);
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.teamFieldValues]).toBe(
      21_600,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.teamIterations]).toBe(
      21_600,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.boardColumns]).toBe(
      21_600,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.capacities]).toBe(
      3_600,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.daysOff]).toBe(3_600);
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.boardSnapshot]).toBe(
      60,
    );
    expect(DEFAULT_CACHE_TTL_SECONDS[CACHE_KEY_TTL_CLASS.columnMapping]).toBe(
      0,
    );
  });
});
