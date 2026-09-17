import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../ado/rate-limit.js';
import { cacheKeys } from '../cache/keys.js';
import { SyncBudget } from './budget.js';
import { SyncWorker, type SyncWorkerOptions } from './worker.js';
import {
  boardFixture,
  FakeAdoClient,
  FakeCacheStore,
  FakeConfigStore,
  RecordingLogger,
  TestClock,
} from './test-support.js';

const ORG = 'expertgroup';

interface Harness {
  readonly worker: SyncWorker;
  readonly ado: FakeAdoClient;
  readonly cache: FakeCacheStore;
  readonly config: FakeConfigStore;
  readonly logger: RecordingLogger;
  readonly clock: TestClock;
}

const harness = (
  overrides: Partial<SyncWorkerOptions> & {
    capacity?: number;
    refillPerMinute?: number;
  } = {},
): Harness => {
  const clock = new TestClock();
  const ado = new FakeAdoClient();
  const cache = new FakeCacheStore();
  const config = new FakeConfigStore();
  const logger = new RecordingLogger();
  const sleep = async (ms: number): Promise<void> => {
    clock.advance(ms);
  };
  const budget = new SyncBudget({
    bucket: new TokenBucket({
      capacity: overrides.capacity ?? 500,
      refillPerMinute: overrides.refillPerMinute ?? 600,
      clock,
      sleep,
    }),
    ado,
    clock,
    sleep,
    maxWaitMs: 1_000,
  });
  let counter = 0;
  const worker = new SyncWorker({
    logger,
    clock,
    ado,
    cache,
    config,
    budget,
    orgId: ORG,
    runOnStart: false,
    newTraceId: () => `trace-${(counter += 1)}`,
    ...overrides,
  });
  return { worker, ado, cache, config, logger, clock };
};

const withBoards = (config: FakeConfigStore, ids: readonly string[]): void => {
  for (const id of ids) {
    const board = boardFixture(id, [
      { projectId: `project-${id}`, teamId: `team-${id}` },
    ]);
    config.definitions.push(board.definition);
    config.sources.set(id, board.sources);
  }
};

describe('SyncWorker cycles', () => {
  it('warms every board definition and then the directory', async () => {
    const { worker, config, cache, ado } = harness();
    withBoards(config, ['board-1', 'board-2']);

    const report = await worker.runCycle();

    expect(report.status).toBe('completed');
    expect(report.boards.map((board) => board.boardId).sort()).toEqual([
      'board-1',
      'board-2',
    ]);
    expect(report.failed).toBe(0);
    expect(report.warmed).toBe(17);
    expect(cache.keys()).toContain(cacheKeys.projects(ORG));
    expect(ado.count('getTeamFieldValues')).toBe(2);
    expect(ado.count('listTeams')).toBe(2);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never runs two cycles at once', async () => {
    const { worker, config } = harness();
    withBoards(config, ['board-1']);

    const [first, second] = await Promise.all([
      worker.runCycle(),
      worker.runCycle(),
    ]);

    expect([first?.status, second?.status].sort()).toEqual([
      'completed',
      'skipped-overlap',
    ]);
    expect(worker.running).toBe(false);
  });

  it('isolates a failing board from the rest of the sweep', async () => {
    const { worker, config, cache } = harness();
    withBoards(config, ['board-1', 'board-2']);
    config.failingSources.add('board-1');

    const report = await worker.runCycle();

    expect(report.status).toBe('completed');
    const failed = report.boards.find((row) => row.boardId === 'board-1');
    const healthy = report.boards.find((row) => row.boardId === 'board-2');
    expect(failed?.error).not.toBeNull();
    expect(healthy).toMatchObject({ failed: 0, warmed: 7 });
    expect(
      cache.keys().filter((key) => key.endsWith(':taskboardcolumns')),
    ).toHaveLength(1);
  });

  it('skips the cycle when the cache is not serving', async () => {
    const { worker, config, cache, ado, logger } = harness();
    withBoards(config, ['board-1']);
    cache.healthy = false;

    const report = await worker.runCycle();

    expect(report.status).toBe('skipped-cache-unhealthy');
    expect(ado.calls).toEqual([]);
    expect(
      logger.matching('sync cycle skipped, cache is unhealthy'),
    ).toHaveLength(1);
  });

  it('yields the whole cycle when Azure DevOps is throttling', async () => {
    const { worker, config, ado, logger } = harness();
    withBoards(config, ['board-1']);
    const observedAt = new TestClock().now();
    ado.rateLimit = {
      remaining: 0,
      limit: 1000,
      resetEpochSeconds: Math.floor(observedAt.getTime() / 1000) + 600,
      retryAfterSeconds: 120,
      observedAt: observedAt.toISOString(),
    };

    const report = await worker.runCycle();

    expect(report.status).toBe('budget-exhausted');
    expect(ado.calls).toEqual([]);
    expect(
      logger.matching(
        'sync cycle skipped, yielding budget to the request path',
      ),
    ).toHaveLength(1);
  });

  it('ends the cycle early, keeping what it warmed, when tokens run out', async () => {
    const { worker, config } = harness({ capacity: 3, refillPerMinute: 1 });
    withBoards(config, ['board-1', 'board-2']);

    const report = await worker.runCycle();

    expect(report.status).toBe('budget-exhausted');
    expect(report.warmed).toBeGreaterThan(0);
  });

  it('reports a failure to list board definitions rather than throwing', async () => {
    const { worker, config, logger } = harness();
    config.definitionsFailure = new Error('postgres is down');

    const report = await worker.runCycle();

    expect(report.status).toBe('failed');
    expect(
      logger.matching('sync cycle failed to list board definitions'),
    ).toHaveLength(1);
  });
});

describe('SyncWorker lifecycle', () => {
  it('starts, schedules and stops without leaving a timer behind', async () => {
    const { worker, config } = harness({ intervalMs: 50, runOnStart: true });
    withBoards(config, ['board-1']);

    worker.start();
    worker.start();
    await worker.stop();

    expect(worker.running).toBe(false);
  });

  it('waits for the cycle in flight instead of abandoning it', async () => {
    const { worker, config, cache } = harness({ runOnStart: false });
    withBoards(config, ['board-1']);

    const cycle = worker.runCycle();
    expect(worker.running).toBe(true);
    await worker.stop();

    const report = await cycle;
    expect(report.status).toBe('completed');
    expect(cache.keys().length).toBeGreaterThan(0);
  });

  it('refuses to start a new cycle once stopped', async () => {
    const { worker, config, ado } = harness();
    withBoards(config, ['board-1']);

    await worker.stop();
    const report = await worker.runCycle();

    expect(report.status).toBe('skipped-stopped');
    expect(ado.calls).toEqual([]);
  });
});
