import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_CACHE_TTL_SECONDS } from '../config.js';
import type { CacheTtlClass, CallOptions } from '../ports.js';
import { createRedisCache, type RedisCacheStore } from './redis-cache.js';
import { FakeRedis, RecordingLogger, TestClock } from './test-support.js';

const options: CallOptions = { traceId: 'trace-1' };
const schema = z.object({ id: z.string(), count: z.number() });

interface Harness {
  readonly cache: RedisCacheStore;
  readonly redis: FakeRedis;
  readonly logger: RecordingLogger;
  readonly clock: TestClock;
}

const harness = (commandTimeoutMs = 50): Harness => {
  const redis = new FakeRedis();
  const logger = new RecordingLogger();
  const clock = new TestClock();
  const cache = createRedisCache({
    client: redis,
    logger,
    clock,
    commandTimeoutMs,
    breaker: { failureThreshold: 2, openDurationMs: 1_000, clock },
  });
  return { cache, redis, logger, clock };
};

describe('RedisCache round trip', () => {
  it('stores and returns a validated value', async () => {
    const { cache } = harness();
    await cache.set('k', { id: 'a', count: 2 }, 'board-snapshot', options);
    expect(await cache.get('k', schema, options)).toEqual({
      id: 'a',
      count: 2,
    });
  });

  it('reports a miss for a key that was never written', async () => {
    const { cache } = harness();
    expect(await cache.get('absent', schema, options)).toBeNull();
  });

  it('reports the age of a hit, for the snapshot cache info', async () => {
    const { cache, clock } = harness();
    await cache.set('k', { id: 'a', count: 1 }, 'board-snapshot', options);
    clock.advance(21_000);
    const entry = await cache.getEntry('k', schema, options);
    expect(entry?.ageSeconds).toBe(21);
  });
});

describe('RedisCache TTL selection', () => {
  const cases: ReadonlyArray<readonly [CacheTtlClass, number]> = [
    ['projects-teams', 86_400],
    ['team-metadata', 21_600],
    ['board-columns', 21_600],
    ['capacity', 3_600],
    ['board-snapshot', 60],
    ['acl', 900],
  ];

  for (const [ttlClass, seconds] of cases) {
    it(`writes ${ttlClass} with a ${seconds}s expiry`, async () => {
      const { cache, redis } = harness();
      await cache.set('k', { id: 'a', count: 1 }, ttlClass, options);
      expect(redis.ttls.get('k')).toBe(seconds);
      expect(redis.names()).toEqual(['setex']);
    });
  }

  it('writes the column mapping without an expiry', async () => {
    const { cache, redis } = harness();
    await cache.set('k', { id: 'a', count: 1 }, 'column-mapping', options);
    expect(redis.names()).toEqual(['set']);
    expect(redis.ttls.get('k')).toBeNull();
  });

  it('uses the configured TTLs rather than a literal at a call site', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache({
      client: redis,
      logger: new RecordingLogger(),
      commandTimeoutMs: 50,
      ttlSeconds: { ...DEFAULT_CACHE_TTL_SECONDS, 'board-snapshot': 15 },
    });
    await cache.set('k', { id: 'a', count: 1 }, 'board-snapshot', options);
    expect(redis.ttls.get('k')).toBe(15);
  });
});

describe('RedisCache shape validation', () => {
  it('treats an entry of the wrong shape as a miss and deletes it', async () => {
    const { cache, redis } = harness();
    await cache.set('k', { id: 'a', legacy: true }, 'board-snapshot', options);
    expect(await cache.get('k', schema, options)).toBeNull();
    expect(redis.values.has('k')).toBe(false);
    expect(redis.names()).toContain('del');
  });

  it('treats an unreadable entry as a miss rather than throwing', async () => {
    const { cache, redis } = harness();
    redis.values.set('k', 'not json at all');
    await expect(cache.get('k', schema, options)).resolves.toBeNull();
    expect(redis.values.has('k')).toBe(false);
  });

  it('treats an entry from an older envelope as a miss', async () => {
    const { cache, redis } = harness();
    redis.values.set('k', JSON.stringify({ v: 0, t: 1, d: { id: 'a' } }));
    await expect(cache.get('k', schema, options)).resolves.toBeNull();
  });
});

describe('RedisCache invalidatePattern', () => {
  it('removes every matching key and counts them', async () => {
    const { cache, redis } = harness();
    const value = { id: 'a', count: 1 };
    await cache.set(
      'eg:v1:board:b1:snapshot:x',
      value,
      'board-snapshot',
      options,
    );
    await cache.set(
      'eg:v1:board:b1:snapshot:y',
      value,
      'board-snapshot',
      options,
    );
    await cache.set(
      'eg:v1:board:b2:snapshot:z',
      value,
      'board-snapshot',
      options,
    );
    const removed = await cache.invalidatePattern(
      'eg:v1:board:b1:snapshot:*',
      options,
    );
    expect(removed).toBe(2);
    expect([...redis.values.keys()]).toEqual(['eg:v1:board:b2:snapshot:z']);
  });
});

describe('RedisCache degraded mode', () => {
  it('reports a miss and stays quiet when Redis is unreachable', async () => {
    const { cache, redis, logger } = harness();
    redis.failure = new Error('ECONNREFUSED');
    expect(await cache.get('k', schema, options)).toBeNull();
    expect(cache.healthy).toBe(false);
    expect(logger.matching('cache degraded, serving without it')).toHaveLength(
      1,
    );
  });

  it('makes writes a no-op rather than an error', async () => {
    const { cache, redis } = harness();
    redis.failure = new Error('ECONNREFUSED');
    await expect(
      cache.set('k', { id: 'a', count: 1 }, 'capacity', options),
    ).resolves.toBeUndefined();
    await expect(cache.delete('k', options)).resolves.toBeUndefined();
    await expect(cache.invalidatePattern('k:*', options)).resolves.toBe(0);
  });

  it('logs once per transition, not once per operation', async () => {
    const { cache, redis, logger, clock } = harness();
    redis.failure = new Error('ECONNREFUSED');
    for (let index = 0; index < 5; index += 1) {
      await cache.get(`k${index}`, schema, options);
    }
    expect(logger.matching('cache degraded, serving without it')).toHaveLength(
      1,
    );

    redis.failure = null;
    clock.advance(1_000);
    await cache.get('k', schema, options);
    await cache.get('k', schema, options);
    expect(cache.healthy).toBe(true);
    expect(logger.matching('cache recovered')).toHaveLength(1);
  });

  it('short-circuits while the breaker is open, adding no timeout', async () => {
    const { cache, redis } = harness();
    redis.failure = new Error('ECONNREFUSED');
    await cache.get('a', schema, options);
    await cache.get('b', schema, options);
    const before = redis.commands.length;
    await cache.get('c', schema, options);
    await cache.get('d', schema, options);
    expect(redis.commands.length).toBe(before);
    expect(cache.healthy).toBe(false);
  });

  it('recovers on the probe once the open window has passed', async () => {
    const { cache, redis, clock } = harness();
    redis.failure = new Error('ECONNREFUSED');
    await cache.get('a', schema, options);
    await cache.get('b', schema, options);
    redis.failure = null;
    clock.advance(1_000);
    await cache.set('k', { id: 'a', count: 1 }, 'capacity', options);
    expect(cache.healthy).toBe(true);
    expect(await cache.get('k', schema, options)).toEqual({
      id: 'a',
      count: 1,
    });
  });

  it('gives up on a wedged command instead of awaiting it forever', async () => {
    const { cache, redis } = harness(5);
    redis.hang = true;
    await expect(cache.get('k', schema, options)).resolves.toBeNull();
    expect(cache.healthy).toBe(false);
  });

  it('honours a per-call timeout override', async () => {
    const { cache, redis } = harness(60_000);
    redis.hang = true;
    const started = Date.now();
    await cache.get('k', schema, { traceId: 't', timeoutMs: 5 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('issues no command once the caller has aborted', async () => {
    const { cache, redis } = harness();
    const controller = new AbortController();
    controller.abort();
    await cache.get('k', schema, {
      traceId: 't',
      signal: controller.signal,
    });
    expect(redis.commands).toHaveLength(0);
  });

  it('never logs a cached value or a connection string', async () => {
    const { cache, redis, logger } = harness();
    redis.failure = new Error('ECONNREFUSED');
    await cache.set('k', { id: 'secret-value', count: 1 }, 'acl', options);
    expect(JSON.stringify(logger.lines)).not.toContain('secret-value');
  });
});
