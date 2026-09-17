import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../ado/rate-limit.js';
import { cacheKeys, type TeamScope } from '../cache/keys.js';
import type { CallOptions } from '../ports.js';
import { SyncBudget } from './budget.js';
import {
  prefetchBoard,
  prefetchOrgDirectory,
  type PrefetchContext,
} from './prefetch.js';
import {
  boardFixture,
  FakeAdoClient,
  FakeCacheStore,
  FakeConfigStore,
  RecordingLogger,
  TestClock,
} from './test-support.js';

const ORG = 'expertgroup';
const options: CallOptions = { traceId: 'trace-sync' };

const scope: TeamScope = {
  orgId: ORG,
  projectId: 'project-1',
  teamId: 'team-1',
};

interface Harness {
  readonly ctx: PrefetchContext;
  readonly ado: FakeAdoClient;
  readonly cache: FakeCacheStore;
  readonly config: FakeConfigStore;
  readonly logger: RecordingLogger;
}

const harness = (budgetTokens = 200, refillPerMinute = 600): Harness => {
  const clock = new TestClock();
  const ado = new FakeAdoClient();
  const cache = new FakeCacheStore();
  const config = new FakeConfigStore();
  const logger = new RecordingLogger();
  const budget = new SyncBudget({
    bucket: new TokenBucket({
      capacity: budgetTokens,
      refillPerMinute,
      clock,
      sleep: async (ms) => clock.advance(ms),
    }),
    ado,
    clock,
    sleep: async (ms) => clock.advance(ms),
    maxWaitMs: 1_000,
  });
  return {
    ctx: { logger, ado, cache, config, budget, orgId: ORG },
    ado,
    cache,
    config,
    logger,
  };
};

describe('prefetchBoard', () => {
  it('warms the spec table: team settings, iterations, columns, capacity', async () => {
    const { ctx, cache, config, ado } = harness();
    const board = boardFixture('board-1', [
      { projectId: 'project-1', teamId: 'team-1' },
    ]);
    config.definitions = [board.definition];
    config.sources.set('board-1', board.sources);

    const report = await prefetchBoard(ctx, board.definition, options);

    expect(report).toMatchObject({
      boardId: 'board-1',
      teamCount: 1,
      failed: 0,
      error: null,
      projectIds: ['project-1'],
    });
    expect(cache.keys()).toEqual([
      cacheKeys.teamFieldValues(scope),
      cacheKeys.teamIterations(scope, 'current'),
      cacheKeys.capacities(scope, 'iteration-1'),
      cacheKeys.daysOff(scope, 'iteration-1'),
      cacheKeys.teamBoards(scope),
      cacheKeys.boardColumns(scope, 'ado-board-1'),
      cacheKeys.taskboardColumns(scope),
    ]);
    expect(report.warmed).toBe(7);
    // The card snapshot is fetched live, never warmed here.
    expect(ado.count('getIterationWorkItems')).toBe(0);
    expect(ado.count('getWorkItemsBatch')).toBe(0);
  });

  it('writes every entry under the TTL class the cache table gives it', async () => {
    const { ctx, cache, config } = harness();
    const board = boardFixture('board-1', [
      { projectId: 'project-1', teamId: 'team-1' },
    ]);
    config.sources.set('board-1', board.sources);

    await prefetchBoard(ctx, board.definition, options);

    expect(cache.ttlOf(cacheKeys.teamFieldValues(scope))).toBe('team-metadata');
    expect(cache.ttlOf(cacheKeys.capacities(scope, 'iteration-1'))).toBe(
      'capacity',
    );
    expect(cache.ttlOf(cacheKeys.daysOff(scope, 'iteration-1'))).toBe(
      'capacity',
    );
    expect(cache.ttlOf(cacheKeys.taskboardColumns(scope))).toBe(
      'board-columns',
    );
  });

  it('steps over a failing call and warms the rest of the team', async () => {
    const { ctx, cache, config, ado, logger } = harness();
    const board = boardFixture('board-1', [
      { projectId: 'project-1', teamId: 'team-1' },
    ]);
    config.sources.set('board-1', board.sources);
    ado.failing.add('getTeamCapacities');

    const report = await prefetchBoard(ctx, board.definition, options);

    expect(report.failed).toBe(1);
    expect(report.warmed).toBe(6);
    expect(cache.keys()).not.toContain(
      cacheKeys.capacities(scope, 'iteration-1'),
    );
    expect(cache.keys()).toContain(cacheKeys.taskboardColumns(scope));
    expect(logger.matching('prefetch entry failed')).toHaveLength(1);
  });

  it('keeps warming the other teams when one team is broken', async () => {
    const { ctx, cache, config, ado } = harness();
    const board = boardFixture('board-1', [
      { projectId: 'project-1', teamId: 'team-1' },
      { projectId: 'project-2', teamId: 'team-2' },
    ]);
    config.sources.set('board-1', board.sources);
    ado.failing.add('getTeamFieldValues');

    const report = await prefetchBoard(ctx, board.definition, options);

    expect(report.teamCount).toBe(2);
    expect(report.failed).toBe(2);
    expect(
      cache.keys().filter((key) => key.endsWith(':taskboardcolumns')),
    ).toHaveLength(2);
    expect(report.projectIds).toEqual(['project-1', 'project-2']);
  });

  it('reports a board whose sources cannot be read, and does not throw', async () => {
    const { ctx, config, logger } = harness();
    const board = boardFixture('board-1', []);
    config.failingSources.add('board-1');

    const report = await prefetchBoard(ctx, board.definition, options);

    expect(report).toMatchObject({ boardId: 'board-1', failed: 1 });
    expect(report.error).not.toBeNull();
    expect(
      logger.matching('board sources unreadable, board skipped'),
    ).toHaveLength(1);
  });

  it('stops the sweep when the shared rate budget is gone', async () => {
    const { ctx, config, cache } = harness(2, 1);
    const board = boardFixture('board-1', [
      { projectId: 'project-1', teamId: 'team-1' },
    ]);
    config.sources.set('board-1', board.sources);

    const report = await prefetchBoard(ctx, board.definition, options);

    expect(report.halted).toBe(true);
    // Whatever it managed before the refusal is still warm, and counted.
    expect(cache.keys()).toHaveLength(2);
    expect(report.warmed).toBe(2);
  });
});

describe('prefetchOrgDirectory', () => {
  it('warms the project list and the teams of the projects in use', async () => {
    const { ctx, cache, ado } = harness();

    const tally = await prefetchOrgDirectory(
      ctx,
      ['project-1', 'project-1', 'project-2'],
      options,
    );

    expect(tally).toEqual({ warmed: 3, failed: 0 });
    expect(ado.count('listTeams')).toBe(2);
    expect(cache.keys()).toEqual([
      cacheKeys.projects(ORG),
      cacheKeys.teams(ORG, 'project-1'),
      cacheKeys.teams(ORG, 'project-2'),
    ]);
    expect(cache.ttlOf(cacheKeys.projects(ORG))).toBe('projects-teams');
  });
});
