/**
 * Warming one board definition ahead of the user.
 *
 * Spec, "Cold start": "The sync worker prefetches every board
 * definition's teams, iterations, columns and capacity on a schedule, so
 * a user opening the hub in the morning hits a warm cache. Only the card
 * snapshot is fetched live, and only when older than 60 seconds." The
 * card snapshot is therefore deliberately absent from everything below.
 *
 * The call list mirrors the spec's "Azure DevOps API surface" table, and
 * every entry is written under the key builder and the TTL class the
 * cache module already declares for it, so a warmed entry is
 * indistinguishable from one the read path wrote.
 *
 * Isolation is per team as well as per board: one team whose settings
 * call fails is counted and stepped over, because the other seven teams
 * on that board are still worth warming. The one exception is a budget
 * refusal, which is rethrown so the whole cycle stops — the interactive
 * path's share of the rate limit is not ours to spend.
 */
import type { BoardDefinition, BoardSource } from '@eg/shared';
import { cacheKeys, type TeamScope } from '../cache/keys.js';
import { toAppError } from '../errors.js';
import type {
  AdoCallOptions,
  AdoClient,
  CacheStore,
  CacheTtlClass,
  CallOptions,
  ConfigStore,
  Logger,
} from '../ports.js';
import { SERVICE_AUTH, SyncBudgetExhausted } from './budget.js';
import type { SyncBudget } from './budget.js';

/** Default per-call timeout for a warming read. Never unbounded. */
export const DEFAULT_SYNC_CALL_TIMEOUT_MS = 10_000;

export interface PrefetchContext {
  readonly logger: Logger;
  readonly ado: AdoClient;
  readonly cache: CacheStore;
  readonly config: ConfigStore;
  readonly budget: SyncBudget;
  readonly orgId: string;
  readonly callTimeoutMs?: number;
}

export interface PrefetchTally {
  warmed: number;
  failed: number;
}

export interface BoardPrefetchReport {
  readonly boardId: string;
  readonly teamCount: number;
  /** The projects this board reads from, for the directory warm. */
  readonly projectIds: readonly string[];
  readonly warmed: number;
  readonly failed: number;
  /**
   * True when the sweep ran out of rate budget part way through this
   * board. Whatever was warmed before the refusal still counts, and the
   * worker ends the cycle rather than starting another board.
   */
  readonly halted: boolean;
  /** Set when the board was abandoned outright, not merely degraded. */
  readonly error: string | null;
}

const adoOptions = (
  ctx: PrefetchContext,
  options: CallOptions,
): AdoCallOptions => ({
  traceId: options.traceId,
  timeoutMs: ctx.callTimeoutMs ?? DEFAULT_SYNC_CALL_TIMEOUT_MS,
  auth: SERVICE_AUTH,
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

/**
 * One warmed cache entry: budget first, then the read, then the write.
 * A failure is logged and counted; a budget refusal is rethrown.
 */
async function warmEntry<T>(
  ctx: PrefetchContext,
  label: string,
  key: string,
  ttl: CacheTtlClass,
  load: (options: AdoCallOptions) => Promise<T>,
  options: CallOptions,
  tally: PrefetchTally,
): Promise<T | null> {
  await ctx.budget.require(options.signal);
  try {
    const value = await load(adoOptions(ctx, options));
    await ctx.cache.set(key, value, ttl, options);
    tally.warmed += 1;
    return value;
  } catch (error) {
    if (error instanceof SyncBudgetExhausted) throw error;
    tally.failed += 1;
    const failure = toAppError(error);
    ctx.logger.withTraceId(options.traceId).warn('prefetch entry failed', {
      entry: label,
      code: failure.code,
      status: failure.status,
    });
    return null;
  }
}

/**
 * The organisation directory: the project list, and the teams of every
 * project some board actually reads from. Shared by every board in the
 * cycle, so it runs once per sweep rather than once per board.
 */
export async function prefetchOrgDirectory(
  ctx: PrefetchContext,
  projectIds: readonly string[],
  options: CallOptions,
): Promise<PrefetchTally> {
  const tally: PrefetchTally = { warmed: 0, failed: 0 };
  await warmEntry(
    ctx,
    'projects',
    cacheKeys.projects(ctx.orgId),
    'projects-teams',
    (call) => ctx.ado.listProjects(call),
    options,
    tally,
  );
  for (const projectId of [...new Set(projectIds)]) {
    await warmEntry(
      ctx,
      'teams',
      cacheKeys.teams(ctx.orgId, projectId),
      'projects-teams',
      (call) => ctx.ado.listTeams(projectId, call),
      options,
      tally,
    );
  }
  return tally;
}

/** Team settings, board columns, capacity and days off for one team. */
export async function prefetchTeam(
  ctx: PrefetchContext,
  source: BoardSource,
  options: CallOptions,
  tally: PrefetchTally,
): Promise<void> {
  const scope: TeamScope = {
    orgId: ctx.orgId,
    projectId: source.projectId,
    teamId: source.teamId,
  };

  await warmEntry(
    ctx,
    'team-field-values',
    cacheKeys.teamFieldValues(scope),
    'team-metadata',
    (call) => ctx.ado.getTeamFieldValues(scope.projectId, scope.teamId, call),
    options,
    tally,
  );

  const iterations = await warmEntry(
    ctx,
    'team-iterations',
    cacheKeys.teamIterations(scope, 'current'),
    'team-metadata',
    (call) =>
      ctx.ado.listTeamIterations(
        scope.projectId,
        scope.teamId,
        'current',
        call,
      ),
    options,
    tally,
  );

  for (const iteration of iterations ?? []) {
    await warmEntry(
      ctx,
      'capacities',
      cacheKeys.capacities(scope, iteration.id),
      'capacity',
      (call) =>
        ctx.ado.getTeamCapacities(
          scope.projectId,
          scope.teamId,
          iteration.id,
          call,
        ),
      options,
      tally,
    );
    await warmEntry(
      ctx,
      'days-off',
      cacheKeys.daysOff(scope, iteration.id),
      'capacity',
      (call) =>
        ctx.ado.getTeamDaysOff(
          scope.projectId,
          scope.teamId,
          iteration.id,
          call,
        ),
      options,
      tally,
    );
  }

  const boards = await warmEntry(
    ctx,
    'team-boards',
    cacheKeys.teamBoards(scope),
    'board-columns',
    (call) => ctx.ado.listBoards(scope.projectId, scope.teamId, call),
    options,
    tally,
  );

  for (const board of boards ?? []) {
    await warmEntry(
      ctx,
      'board-columns',
      cacheKeys.boardColumns(scope, board.id),
      'board-columns',
      (call) => ctx.ado.getBoard(scope.projectId, scope.teamId, board.id, call),
      options,
      tally,
    );
  }

  await warmEntry(
    ctx,
    'taskboard-columns',
    cacheKeys.taskboardColumns(scope),
    'board-columns',
    (call) => ctx.ado.getTaskboardColumns(scope.projectId, scope.teamId, call),
    options,
    tally,
  );
}

/**
 * Warms one board definition. Never throws: a team-level failure is
 * counted, a budget refusal sets `halted`, and an unreadable source set
 * is one report row with an error code. Whatever was warmed before any
 * of those still counts.
 */
export async function prefetchBoard(
  ctx: PrefetchContext,
  definition: BoardDefinition,
  options: CallOptions,
): Promise<BoardPrefetchReport> {
  const tally: PrefetchTally = { warmed: 0, failed: 0 };
  const log = ctx.logger.withTraceId(options.traceId);
  let sources: readonly BoardSource[];
  try {
    sources = await ctx.config.listBoardSources(definition.id, options);
  } catch (error) {
    if (error instanceof SyncBudgetExhausted) throw error;
    const failure = toAppError(error);
    log.error('board sources unreadable, board skipped', {
      boardId: definition.id,
      code: failure.code,
    });
    return {
      boardId: definition.id,
      teamCount: 0,
      projectIds: [],
      warmed: 0,
      failed: 1,
      halted: false,
      error: failure.code,
    };
  }

  let halted = false;
  for (const source of sources) {
    try {
      await prefetchTeam(ctx, source, options, tally);
    } catch (error) {
      if (error instanceof SyncBudgetExhausted) {
        halted = true;
        log.warn('team prefetch yielded the rate budget', {
          boardId: definition.id,
          projectId: source.projectId,
          teamId: source.teamId,
          reason: error.reason,
          waitMs: error.waitMs,
        });
        break;
      }
      tally.failed += 1;
      const failure = toAppError(error);
      log.warn('team prefetch failed, continuing', {
        boardId: definition.id,
        projectId: source.projectId,
        teamId: source.teamId,
        code: failure.code,
      });
    }
  }

  log.info('board prefetched', {
    boardId: definition.id,
    teamCount: sources.length,
    warmed: tally.warmed,
    failed: tally.failed,
    halted,
  });
  return {
    boardId: definition.id,
    teamCount: sources.length,
    projectIds: [...new Set(sources.map((source) => source.projectId))],
    warmed: tally.warmed,
    failed: tally.failed,
    halted,
    error: null,
  };
}
