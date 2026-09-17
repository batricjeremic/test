/**
 * Every Redis key the service uses is built here, and nowhere else.
 *
 * Serves the spec's "Caching, rate limits and realtime" table. Two
 * properties matter more than tidiness:
 *
 * - keys are namespaced by organisation, by team and by board, so one
 *   board's invalidation can never reach another's;
 * - the invalidation patterns are derived from the same builders as the
 *   write paths, so a pattern cannot drift away from the keys it is
 *   meant to match.
 *
 * Nothing here talks to Redis, so every key is unit-testable.
 */
import { createHash } from 'node:crypto';
import type { CacheTtlClass } from '../ports.js';

/** Root namespace, so the database can be shared if it ever has to be. */
export const CACHE_NAMESPACE = 'eg';

/**
 * Bumped when an entry's encoding changes in a way a Zod schema would
 * not catch. Old keys then simply expire unread.
 */
export const CACHE_SCHEMA_VERSION = 'v1';

const PREFIX = `${CACHE_NAMESPACE}:${CACHE_SCHEMA_VERSION}`;

/** Longest a single segment may be before it is hashed down. */
const MAX_SEGMENT_LENGTH = 96;

const UNSAFE_SEGMENT = /[^A-Za-z0-9._@-]/gu;

/**
 * Makes an arbitrary id safe to place in a key: no separators, no glob
 * metacharacters, bounded length. Long values keep a readable head and
 * gain a digest tail, so two long ids can never collide.
 */
export function cacheSegment(value: string): string {
  const cleaned = value.trim().replace(UNSAFE_SEGMENT, '_');
  const safe = cleaned.length === 0 ? '_' : cleaned;
  if (safe.length <= MAX_SEGMENT_LENGTH) return safe;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${safe.slice(0, MAX_SEGMENT_LENGTH - 17)}~${digest}`;
}

/**
 * A stable fingerprint of a snapshot query: alignment, grouping,
 * filters and the caller's ACL scope all change the bytes a snapshot
 * contains, so they all belong in its key.
 */
export function cacheFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, 32);
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
};

/** The (project, team) pair every team-scoped Azure DevOps read needs. */
export interface TeamScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly teamId: string;
}

const orgScope = (orgId: string): string =>
  `${PREFIX}:org:${cacheSegment(orgId)}`;

const projectScope = (orgId: string, projectId: string): string =>
  `${orgScope(orgId)}:project:${cacheSegment(projectId)}`;

const teamScope = (scope: TeamScope): string =>
  `${projectScope(scope.orgId, scope.projectId)}:team:${cacheSegment(
    scope.teamId,
  )}`;

const boardScope = (boardId: string): string =>
  `${PREFIX}:board:${cacheSegment(boardId)}`;

/**
 * One builder per cache entry in the spec's table. Each builder's doc
 * comment opens with the TTL class its entries are written with; that
 * pairing is also machine-readable, as `CACHE_KEY_TTL_CLASS` below.
 */
export const cacheKeys = {
  /** projects-teams: the organisation's project list. */
  projects: (orgId: string): string => `${orgScope(orgId)}:projects`,

  /** projects-teams: one project's teams. */
  teams: (orgId: string, projectId: string): string =>
    `${projectScope(orgId, projectId)}:teams`,

  /** team-metadata: the team's area paths. */
  teamFieldValues: (scope: TeamScope): string =>
    `${teamScope(scope)}:teamfields`,

  /** team-metadata: iterations, by timeframe (`all` when unfiltered). */
  teamIterations: (scope: TeamScope, timeframe: string | null): string =>
    `${teamScope(scope)}:iterations:${cacheSegment(timeframe ?? 'all')}`,

  /** team-metadata: the work item ids in one team iteration. */
  iterationWorkItems: (scope: TeamScope, iterationId: string): string =>
    `${teamScope(scope)}:iteration:${cacheSegment(iterationId)}:workitems`,

  /** board-columns: the team's board references. */
  teamBoards: (scope: TeamScope): string => `${teamScope(scope)}:boards`,

  /** board-columns: one Azure DevOps board's column definitions. */
  boardColumns: (scope: TeamScope, adoBoardId: string): string =>
    `${teamScope(scope)}:board:${cacheSegment(adoBoardId)}:columns`,

  /** board-columns: the team's taskboard columns. */
  taskboardColumns: (scope: TeamScope): string =>
    `${teamScope(scope)}:taskboardcolumns`,

  /** capacity: per-member capacity for one iteration. */
  capacities: (scope: TeamScope, iterationId: string): string =>
    `${teamScope(scope)}:iteration:${cacheSegment(iterationId)}:capacities`,

  /** capacity: the team's days off for one iteration. */
  daysOff: (scope: TeamScope, iterationId: string): string =>
    `${teamScope(scope)}:iteration:${cacheSegment(iterationId)}:daysoff`,

  /** acl: one caller's readable and writable scope. */
  acl: (orgId: string, descriptor: string): string =>
    `${orgScope(orgId)}:acl:${cacheSegment(descriptor)}`,

  /** board-snapshot: one rendering of a board, keyed by its query. */
  boardSnapshot: (boardId: string, fingerprint: string): string =>
    `${boardScope(boardId)}:snapshot:${cacheSegment(fingerprint)}`,

  /** column-mapping: the board's mapping rows. Never expires. */
  columnMapping: (boardId: string): string => `${boardScope(boardId)}:mapping`,

  /**
   * board-snapshot: reverse index from a work item to the boards whose
   * snapshots contain it, so a `workitem.updated` hook can be resolved
   * to the snapshots it invalidates.
   */
  workItemBoards: (workItemId: number): string =>
    `${PREFIX}:workitem:${cacheSegment(String(workItemId))}:boards`,
} as const;

/**
 * Glob patterns for `CacheStore.invalidatePattern`. Each one is anchored
 * on the same scope helper as the keys it must match.
 */
export const cachePatterns = {
  /** Everything held for one board: snapshots, mapping, indexes. */
  board: (boardId: string): string => `${boardScope(boardId)}:*`,

  /** Only the board's snapshots; the mapping survives. */
  boardSnapshots: (boardId: string): string =>
    `${boardScope(boardId)}:snapshot:*`,

  /** Everything held for one team. */
  team: (scope: TeamScope): string => `${teamScope(scope)}:*`,

  /** The team's iteration-scoped entries: work items, capacity, days off. */
  teamIterationEntries: (scope: TeamScope): string =>
    `${teamScope(scope)}:iteration:*`,

  /** The team's iteration lists, whatever timeframe they were read by. */
  teamIterationLists: (scope: TeamScope): string =>
    `${teamScope(scope)}:iterations:*`,

  /** The team's board and taskboard column definitions. */
  teamBoardColumns: (scope: TeamScope): string =>
    `${teamScope(scope)}:board:*:columns`,

  /**
   * Every project-scoped entry for one organisation: the project list
   * and everything cached beneath each project. Used by the nightly
   * sync and by an admin who has changed the board's source set.
   */
  orgDirectory: (orgId: string): string => `${orgScope(orgId)}:project*`,
} as const;

/**
 * The spec's cache table, expressed as code: every key builder names the
 * TTL class its entries are written with. Callers pass the class to
 * `CacheStore.set`, so this map is what keeps the two in step and is
 * asserted by the tests.
 */
export const CACHE_KEY_TTL_CLASS = {
  projects: 'projects-teams',
  teams: 'projects-teams',
  teamFieldValues: 'team-metadata',
  teamIterations: 'team-metadata',
  iterationWorkItems: 'team-metadata',
  teamBoards: 'board-columns',
  boardColumns: 'board-columns',
  taskboardColumns: 'board-columns',
  capacities: 'capacity',
  daysOff: 'capacity',
  acl: 'acl',
  boardSnapshot: 'board-snapshot',
  columnMapping: 'column-mapping',
  workItemBoards: 'board-snapshot',
} satisfies Record<keyof typeof cacheKeys, CacheTtlClass>;
