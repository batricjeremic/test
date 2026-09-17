/**
 * The invalidation entry points the rest of the system calls, so no
 * other module ever writes a key pattern of its own.
 *
 * Serves the "Invalidated by" column of the spec's cache table:
 *
 * | Entry                    | Invalidated by                        |
 * | Projects and teams       | admin action, nightly sync            |
 * | Team area paths, iters   | nightly sync                          |
 * | Board ids and columns    | admin action in the mapping screen    |
 * | Capacity and days off    | team settings hook, hourly sync       |
 * | Board snapshot           | `workitem.updated` hook, own write    |
 * | Column mapping           | written by the admin screen           |
 *
 * A `workitem.updated` hook names a work item, not a board, so the
 * snapshot writer leaves a reverse index behind and `invalidateWorkItem`
 * reads it back. Everything here runs on the `CacheStore` port, so it is
 * tested against a fake and degrades with the store: when Redis is down
 * an invalidation removes nothing, which is correct, because a cache
 * that is not serving cannot be serving something stale.
 */
import { z } from 'zod';
import type { CacheStore, CallOptions, Logger } from '../ports.js';
import { cacheKeys, cachePatterns, type TeamScope } from './keys.js';

/** The reverse index body: the boards a work item appears on. */
const workItemBoardsSchema = z.array(z.string().min(1));

/** How many index entries are read or written at a time. */
const INDEX_CHUNK = 32;

export interface CacheInvalidator {
  /** Everything held for one board, including its column mapping. */
  invalidateBoard(boardId: string, options: CallOptions): Promise<number>;

  /** The board's snapshots only. Used after an own write. */
  invalidateBoardSnapshots(
    boardId: string,
    options: CallOptions,
  ): Promise<number>;

  /**
   * Resolves the work item to the boards whose snapshots contain it and
   * invalidates those. Returns the ids of the boards it touched, so the
   * caller can push a realtime delta on exactly those channels.
   */
  invalidateWorkItem(
    workItemId: number,
    options: CallOptions,
  ): Promise<readonly string[]>;

  /**
   * A team settings change: area paths, iterations, capacity and days
   * off. Board column definitions are left alone; those are flushed by
   * the mapping screen.
   */
  invalidateTeamSettings(
    scope: TeamScope,
    options: CallOptions,
  ): Promise<number>;

  /** Nightly or admin refresh of the organisation's projects and teams. */
  invalidateOrgDirectory(orgId: string, options: CallOptions): Promise<number>;

  /**
   * The admin mapping screen: board ids, column definitions and the
   * board's own mapping and snapshots, for every team the board covers.
   */
  flushBoardColumns(
    boardId: string,
    scopes: readonly TeamScope[],
    options: CallOptions,
  ): Promise<number>;

  /**
   * Records that these work items appear on this board. Called by the
   * snapshot writer, with the same trace id, before the snapshot is
   * handed back.
   */
  rememberWorkItems(
    boardId: string,
    workItemIds: readonly number[],
    options: CallOptions,
  ): Promise<void>;
}

class StoreCacheInvalidator implements CacheInvalidator {
  private readonly cache: CacheStore;
  private readonly logger: Logger;

  constructor(cache: CacheStore, logger: Logger) {
    this.cache = cache;
    this.logger = logger.child({ component: 'cache-invalidation' });
  }

  async invalidateBoard(
    boardId: string,
    options: CallOptions,
  ): Promise<number> {
    const removed = await this.cache.invalidatePattern(
      cachePatterns.board(boardId),
      options,
    );
    this.log(options).info('board cache invalidated', { boardId, removed });
    return removed;
  }

  async invalidateBoardSnapshots(
    boardId: string,
    options: CallOptions,
  ): Promise<number> {
    return this.cache.invalidatePattern(
      cachePatterns.boardSnapshots(boardId),
      options,
    );
  }

  async invalidateWorkItem(
    workItemId: number,
    options: CallOptions,
  ): Promise<readonly string[]> {
    const boardIds = await this.cache.get(
      cacheKeys.workItemBoards(workItemId),
      workItemBoardsSchema,
      options,
    );
    if (boardIds === null || boardIds.length === 0) {
      this.log(options).debug('work item is on no cached board', {
        workItemId,
      });
      return [];
    }

    for (const boardId of boardIds) {
      await this.invalidateBoardSnapshots(boardId, options);
    }
    this.log(options).info('work item cache invalidated', {
      workItemId,
      boardCount: boardIds.length,
    });
    return boardIds;
  }

  async invalidateTeamSettings(
    scope: TeamScope,
    options: CallOptions,
  ): Promise<number> {
    let removed = await this.cache.invalidatePattern(
      cachePatterns.teamIterationEntries(scope),
      options,
    );
    removed += await this.cache.invalidatePattern(
      cachePatterns.teamIterationLists(scope),
      options,
    );
    await this.cache.delete(cacheKeys.teamFieldValues(scope), options);
    this.log(options).info('team settings cache invalidated', {
      projectId: scope.projectId,
      teamId: scope.teamId,
      removed,
    });
    return removed;
  }

  async invalidateOrgDirectory(
    orgId: string,
    options: CallOptions,
  ): Promise<number> {
    await this.cache.delete(cacheKeys.projects(orgId), options);
    return this.cache.invalidatePattern(
      cachePatterns.orgDirectory(orgId),
      options,
    );
  }

  async flushBoardColumns(
    boardId: string,
    scopes: readonly TeamScope[],
    options: CallOptions,
  ): Promise<number> {
    let removed = 0;
    for (const scope of scopes) {
      await this.cache.delete(cacheKeys.teamBoards(scope), options);
      await this.cache.delete(cacheKeys.taskboardColumns(scope), options);
      removed += await this.cache.invalidatePattern(
        cachePatterns.teamBoardColumns(scope),
        options,
      );
    }
    await this.cache.delete(cacheKeys.columnMapping(boardId), options);
    removed += await this.invalidateBoardSnapshots(boardId, options);
    this.log(options).info('board columns flushed', {
      boardId,
      teamCount: scopes.length,
      removed,
    });
    return removed;
  }

  async rememberWorkItems(
    boardId: string,
    workItemIds: readonly number[],
    options: CallOptions,
  ): Promise<void> {
    const unique = [...new Set(workItemIds)];
    for (let index = 0; index < unique.length; index += INDEX_CHUNK) {
      const chunk = unique.slice(index, index + INDEX_CHUNK);
      await Promise.all(
        chunk.map((workItemId) => this.index(boardId, workItemId, options)),
      );
    }
  }

  private async index(
    boardId: string,
    workItemId: number,
    options: CallOptions,
  ): Promise<void> {
    const key = cacheKeys.workItemBoards(workItemId);
    const current = await this.cache.get(key, workItemBoardsSchema, options);
    if (current !== null && current.includes(boardId)) return;
    const next = current === null ? [boardId] : [...current, boardId];
    await this.cache.set(key, next, 'board-snapshot', options);
  }

  private log(options: CallOptions): Logger {
    return this.logger.withTraceId(options.traceId);
  }
}

export function createCacheInvalidator(
  cache: CacheStore,
  logger: Logger,
): CacheInvalidator {
  return new StoreCacheInvalidator(cache, logger);
}
