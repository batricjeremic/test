import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallOptions } from '../ports.js';
import { createCacheInvalidator } from './invalidation.js';
import { cacheKeys, type TeamScope } from './keys.js';
import { createRedisCache, type RedisCacheStore } from './redis-cache.js';
import { FakeRedis, RecordingLogger, TestClock } from './test-support.js';

const options: CallOptions = { traceId: 'trace-1' };

const scope: TeamScope = {
  orgId: 'expertgroup',
  projectId: 'proj-dev',
  teamId: 'team-alpha',
};

interface Harness {
  readonly cache: RedisCacheStore;
  readonly redis: FakeRedis;
  readonly logger: RecordingLogger;
}

const harness = (): Harness => {
  const redis = new FakeRedis();
  const logger = new RecordingLogger();
  const cache = createRedisCache({
    client: redis,
    logger,
    clock: new TestClock(),
    commandTimeoutMs: 50,
  });
  return { cache, redis, logger };
};

const seedSnapshot = async (
  cache: RedisCacheStore,
  boardId: string,
  fingerprint: string,
): Promise<string> => {
  const key = cacheKeys.boardSnapshot(boardId, fingerprint);
  await cache.set(key, { workItemId: 1 }, 'board-snapshot', options);
  return key;
};

describe('invalidateBoard', () => {
  it('drops the board snapshots and its mapping, and nothing else', async () => {
    const { cache, redis } = harness();
    await seedSnapshot(cache, 'b1', 'f1');
    await cache.set(
      cacheKeys.columnMapping('b1'),
      { workItemId: 1 },
      'column-mapping',
      options,
    );
    const otherBoard = await seedSnapshot(cache, 'b2', 'f1');

    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    const removed = await invalidator.invalidateBoard('b1', options);

    expect(removed).toBe(2);
    expect([...redis.values.keys()]).toEqual([otherBoard]);
  });
});

describe('invalidateBoardSnapshots', () => {
  it('leaves the column mapping in place', async () => {
    const { cache, redis } = harness();
    await seedSnapshot(cache, 'b1', 'f1');
    const mapping = cacheKeys.columnMapping('b1');
    await cache.set(mapping, { workItemId: 1 }, 'column-mapping', options);

    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.invalidateBoardSnapshots('b1', options);

    expect([...redis.values.keys()]).toEqual([mapping]);
  });
});

describe('invalidateWorkItem', () => {
  it('resolves the work item to the boards whose snapshots hold it', async () => {
    const { cache, redis } = harness();
    await seedSnapshot(cache, 'b1', 'f1');
    await seedSnapshot(cache, 'b1', 'f2');
    const untouched = await seedSnapshot(cache, 'b3', 'f1');
    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.rememberWorkItems('b1', [42, 42, 7], options);
    await invalidator.rememberWorkItems('b2', [42], options);

    const boards = await invalidator.invalidateWorkItem(42, options);

    expect([...boards]).toEqual(['b1', 'b2']);
    expect(redis.values.has(untouched)).toBe(true);
    expect(redis.values.has(cacheKeys.boardSnapshot('b1', 'f1'))).toBe(false);
    expect(redis.values.has(cacheKeys.boardSnapshot('b1', 'f2'))).toBe(false);
  });

  it('is a no-op for a work item on no cached board', async () => {
    const { cache } = harness();
    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await expect(invalidator.invalidateWorkItem(99, options)).resolves.toEqual(
      [],
    );
  });

  it('indexes a work item once per board', async () => {
    const { cache } = harness();
    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.rememberWorkItems('b1', [5], options);
    await invalidator.rememberWorkItems('b1', [5], options);
    const index = await cache.get(
      cacheKeys.workItemBoards(5),
      z.array(z.string()),
      options,
    );
    expect(index).toEqual(['b1']);
  });
});

describe('invalidateTeamSettings', () => {
  it('drops capacity, days off, iterations and area paths for that team', async () => {
    const { cache, redis } = harness();
    const value = { workItemId: 1 };
    await cache.set(
      cacheKeys.capacities(scope, 'i1'),
      value,
      'capacity',
      options,
    );
    await cache.set(cacheKeys.daysOff(scope, 'i1'), value, 'capacity', options);
    await cache.set(
      cacheKeys.teamIterations(scope, 'current'),
      value,
      'team-metadata',
      options,
    );
    await cache.set(
      cacheKeys.teamFieldValues(scope),
      value,
      'team-metadata',
      options,
    );
    const other: TeamScope = { ...scope, teamId: 'team-beta' };
    const spared = cacheKeys.capacities(other, 'i1');
    await cache.set(spared, value, 'capacity', options);

    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.invalidateTeamSettings(scope, options);

    expect([...redis.values.keys()]).toEqual([spared]);
  });
});

describe('flushBoardColumns', () => {
  it('drops board ids, column definitions, mapping and snapshots', async () => {
    const { cache, redis } = harness();
    const value = { workItemId: 1 };
    await cache.set(
      cacheKeys.teamBoards(scope),
      value,
      'board-columns',
      options,
    );
    await cache.set(
      cacheKeys.boardColumns(scope, 'ado-board-1'),
      value,
      'board-columns',
      options,
    );
    await cache.set(
      cacheKeys.taskboardColumns(scope),
      value,
      'board-columns',
      options,
    );
    await cache.set(
      cacheKeys.columnMapping('b1'),
      value,
      'column-mapping',
      options,
    );
    await seedSnapshot(cache, 'b1', 'f1');

    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.flushBoardColumns('b1', [scope], options);

    expect([...redis.values.keys()]).toEqual([]);
  });
});

describe('invalidateOrgDirectory', () => {
  it('drops the project list and everything below it', async () => {
    const { cache, redis } = harness();
    const value = { workItemId: 1 };
    await cache.set(
      cacheKeys.projects('expertgroup'),
      value,
      'projects-teams',
      options,
    );
    await cache.set(
      cacheKeys.teams('expertgroup', 'proj-dev'),
      value,
      'projects-teams',
      options,
    );
    await cache.set(
      cacheKeys.teamFieldValues(scope),
      value,
      'team-metadata',
      options,
    );

    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await invalidator.invalidateOrgDirectory('expertgroup', options);

    expect([...redis.values.keys()]).toEqual([]);
  });
});

describe('degraded invalidation', () => {
  it('removes nothing and does not throw when Redis is down', async () => {
    const { cache, redis } = harness();
    redis.failure = new Error('ECONNREFUSED');
    const invalidator = createCacheInvalidator(cache, new RecordingLogger());
    await expect(invalidator.invalidateBoard('b1', options)).resolves.toBe(0);
    await expect(invalidator.invalidateWorkItem(1, options)).resolves.toEqual(
      [],
    );
    await expect(
      invalidator.rememberWorkItems('b1', [1], options),
    ).resolves.toBeUndefined();
  });
});
