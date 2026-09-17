/**
 * The sync worker.
 *
 * Spec, "Cold start": the worker walks every board definition and warms
 * teams, iterations, columns, capacity and days off on a schedule, "so a
 * user opening the hub in the morning hits a warm cache".
 *
 * The lifecycle rules are the ones that keep a background sweep from
 * becoming an incident of its own:
 *
 * - **Never overlap.** A cycle that is still running when the timer
 *   fires again wins; the new one is skipped and says so, because two
 *   sweeps would double the read cost of the shared rate budget.
 * - **Stop cleanly.** `stop()` clears the timer and waits for the cycle
 *   in flight, so the process never exits between an Azure DevOps read
 *   and the cache write that read was for.
 * - **Isolate boards.** One board definition failing is one line in the
 *   report, not the end of the sweep.
 * - **Yield the budget.** A refusal from `SyncBudget` ends the cycle
 *   immediately and the next timer tick tries again, because the
 *   interactive path's share of the rate limit is not ours to spend.
 */
import { newTraceId as defaultTraceId } from '../logging.js';
import { toAppError } from '../errors.js';
import type {
  AdoClient,
  CacheStore,
  CallOptions,
  Clock,
  ConfigStore,
  Logger,
} from '../ports.js';
import { SyncBudgetExhausted } from './budget.js';
import type { SyncBudget } from './budget.js';
import {
  prefetchBoard,
  prefetchOrgDirectory,
  type BoardPrefetchReport,
  type PrefetchContext,
  type PrefetchTally,
} from './prefetch.js';

/**
 * Hourly, matching the spec's shortest warmed TTL: capacity and days off
 * expire after an hour and are "invalidated by ... hourly sync".
 */
export const DEFAULT_SYNC_INTERVAL_MS = 3_600_000;

/** Bounds a whole sweep, so no cycle can wait for ever. */
export const DEFAULT_CYCLE_TIMEOUT_MS = 600_000;

/** Spec: "the worker runs at low concurrency". */
export const DEFAULT_SYNC_CONCURRENCY = 2;

export type SyncCycleStatus =
  | 'completed'
  | 'skipped-overlap'
  | 'skipped-stopped'
  | 'skipped-cache-unhealthy'
  | 'budget-exhausted'
  | 'failed';

export interface SyncCycleReport {
  readonly traceId: string;
  readonly status: SyncCycleStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly boards: readonly BoardPrefetchReport[];
  readonly directory: PrefetchTally;
  readonly warmed: number;
  readonly failed: number;
}

export interface SyncWorkerOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ado: AdoClient;
  readonly cache: CacheStore;
  readonly config: ConfigStore;
  readonly budget: SyncBudget;
  readonly orgId: string;
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly callTimeoutMs?: number;
  readonly cycleTimeoutMs?: number;
  readonly newTraceId?: () => string;
  /** Whether `start()` also runs a cycle straight away. Default true. */
  readonly runOnStart?: boolean;
}

export class SyncWorker {
  readonly #options: SyncWorkerOptions;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #concurrency: number;
  readonly #cycleTimeoutMs: number;
  readonly #traceId: () => string;
  #timer: ReturnType<typeof setInterval> | null = null;
  #current: Promise<SyncCycleReport> | null = null;
  #stopped = false;

  constructor(options: SyncWorkerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'sync-worker' });
    this.#intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.#concurrency = Math.max(
      1,
      options.concurrency ?? DEFAULT_SYNC_CONCURRENCY,
    );
    this.#cycleTimeoutMs = options.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS;
    this.#traceId = options.newTraceId ?? defaultTraceId;
  }

  /** True while a cycle is in flight. */
  get running(): boolean {
    return this.#current !== null;
  }

  /** Starts the schedule. Idempotent; the timer never holds the loop. */
  start(): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    const timer = setInterval(() => {
      void this.runCycle();
    }, this.#intervalMs);
    timer.unref?.();
    this.#timer = timer;
    this.#logger.info('sync worker started', {
      intervalMs: this.#intervalMs,
      concurrency: this.#concurrency,
    });
    if (this.#options.runOnStart !== false) void this.runCycle();
  }

  /**
   * Stops the schedule and waits for the cycle in flight, so an
   * in-flight sweep is never abandoned mid-write to the cache.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const current = this.#current;
    if (current !== null) await current;
    this.#logger.info('sync worker stopped');
  }

  /**
   * Runs one sweep. Never rejects and never overlaps another: a cycle
   * asked for while one is running reports `skipped-overlap`.
   */
  async runCycle(): Promise<SyncCycleReport> {
    if (this.#current !== null) {
      this.#logger.debug('sync cycle skipped, one is already running');
      return this.#report(
        this.#traceId(),
        'skipped-overlap',
        [],
        { warmed: 0, failed: 0 },
        this.#options.clock.now(),
      );
    }
    const cycle = this.#cycle();
    this.#current = cycle;
    try {
      return await cycle;
    } finally {
      this.#current = null;
    }
  }

  async #cycle(): Promise<SyncCycleReport> {
    const traceId = this.#traceId();
    const log = this.#logger.withTraceId(traceId);
    const startedAt = this.#options.clock.now();
    const empty: PrefetchTally = { warmed: 0, failed: 0 };
    if (this.#stopped) {
      return this.#report(traceId, 'skipped-stopped', [], empty, startedAt);
    }
    if (!this.#options.cache.healthy) {
      log.warn('sync cycle skipped, cache is unhealthy');
      return this.#report(
        traceId,
        'skipped-cache-unhealthy',
        [],
        empty,
        startedAt,
      );
    }
    const decision = this.#options.budget.decide();
    if (!decision.granted) {
      log.warn('sync cycle skipped, yielding budget to the request path', {
        reason: decision.reason,
        waitMs: decision.waitMs,
      });
      return this.#report(traceId, 'budget-exhausted', [], empty, startedAt);
    }

    const options: CallOptions = {
      traceId,
      timeoutMs: this.#options.callTimeoutMs ?? undefined,
      signal: AbortSignal.timeout(this.#cycleTimeoutMs),
    };
    const ctx: PrefetchContext = {
      logger: this.#logger,
      ado: this.#options.ado,
      cache: this.#options.cache,
      config: this.#options.config,
      budget: this.#options.budget,
      orgId: this.#options.orgId,
      ...(this.#options.callTimeoutMs === undefined
        ? {}
        : { callTimeoutMs: this.#options.callTimeoutMs }),
    };

    let definitions;
    try {
      definitions = await this.#options.config.listBoardDefinitions(
        this.#options.orgId,
        options,
      );
    } catch (error) {
      const failure = toAppError(error);
      log.error('sync cycle failed to list board definitions', {
        code: failure.code,
        status: failure.status,
      });
      return this.#report(traceId, 'failed', [], empty, startedAt);
    }

    const boards: BoardPrefetchReport[] = [];
    const queue = [...definitions];
    // Set once the rate budget refuses: the sweep stops starting boards.
    let halted = false;

    const runner = async (): Promise<void> => {
      for (;;) {
        // `stop()` waits for the cycle rather than abandoning it, so a
        // sweep in flight is never cut off mid-write to the cache.
        if (halted) return;
        const definition = queue.shift();
        if (definition === undefined) return;
        try {
          const report = await prefetchBoard(ctx, definition, options);
          boards.push(report);
          if (report.halted) {
            halted = true;
            return;
          }
        } catch (error) {
          if (error instanceof SyncBudgetExhausted) {
            halted = true;
            return;
          }
          // Per-board isolation: one bad definition is one report row.
          const failure = toAppError(error);
          log.error('board prefetch failed, sweep continues', {
            boardId: definition.id,
            code: failure.code,
          });
          boards.push({
            boardId: definition.id,
            teamCount: 0,
            projectIds: [],
            warmed: 0,
            failed: 1,
            halted: false,
            error: failure.code,
          });
        }
      }
    };

    const lanes = Math.min(this.#concurrency, Math.max(1, queue.length));
    await Promise.all(Array.from({ length: lanes }, () => runner()));

    let directory: PrefetchTally = { warmed: 0, failed: 0 };
    if (!halted) {
      const projectIds = boards.flatMap((board) => [...board.projectIds]);
      try {
        directory = await prefetchOrgDirectory(ctx, projectIds, options);
      } catch (error) {
        if (error instanceof SyncBudgetExhausted) {
          halted = true;
        } else {
          const failure = toAppError(error);
          log.warn('directory prefetch failed', { code: failure.code });
          directory = { warmed: 0, failed: 1 };
        }
      }
    }

    const status: SyncCycleStatus = halted ? 'budget-exhausted' : 'completed';
    if (halted) {
      log.warn('sync cycle ended early on the rate budget', {
        boardsWarmed: boards.length,
      });
    }
    const report = this.#report(traceId, status, boards, directory, startedAt);
    log.info('sync cycle finished', {
      status: report.status,
      boardCount: report.boards.length,
      warmed: report.warmed,
      failed: report.failed,
      durationMs: report.durationMs,
    });
    return report;
  }

  #report(
    traceId: string,
    status: SyncCycleStatus,
    boards: readonly BoardPrefetchReport[],
    directory: PrefetchTally,
    startedAt: Date,
  ): SyncCycleReport {
    const finishedAt = this.#options.clock.now();
    const warmed =
      directory.warmed + boards.reduce((sum, row) => sum + row.warmed, 0);
    const failed =
      directory.failed + boards.reduce((sum, row) => sum + row.failed, 0);
    return {
      traceId,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      boards,
      directory,
      warmed,
      failed,
    };
  }
}
