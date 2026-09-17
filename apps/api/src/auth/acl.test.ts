/**
 * The ACL resolver: the caller's own token asks Azure DevOps what the
 * caller can see, the answer is cached for the spec's 15 minutes, and a
 * failure to resolve fails the request rather than widening it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE_TTL_SECONDS } from '../config.js';
import { cacheKeys } from '../cache/keys.js';
import { UpstreamError } from '../errors.js';
import type { CallOptions, CallerIdentity } from '../ports.js';
import {
  ACL_TTL_MINUTES,
  ACL_TTL_MS,
  CachingAclResolver,
  cachedAclSchema,
  mapWithConcurrency,
  nothingWritable,
  restrictWritableTo,
} from './acl.js';
import {
  FakeAdoClient,
  FakeCacheStore,
  RecordingLogger,
  TEST_DESCRIPTOR,
  TestClock,
} from './test-support.js';

const ORG_ID = 'org-expertgroup';

const identity: CallerIdentity = {
  descriptor: TEST_DESCRIPTOR,
  id: '11111111-2222-3333-4444-555555555555',
  accessToken: 'super-secret-user-token',
};

const options: CallOptions = { traceId: 'trace-acl' };

const projects = [
  {
    id: 'Delivery',
    teams: [
      { id: 'web', areaPaths: ['Delivery\\Web'] },
      { id: 'data', areaPaths: ['Delivery\\Data', 'Delivery\\Web\\Shared'] },
    ],
  },
  { id: 'Platform', teams: [{ id: 'core', areaPaths: ['Platform'] }] },
];

interface Harness {
  readonly ado: FakeAdoClient;
  readonly cache: FakeCacheStore;
  readonly clock: TestClock;
  readonly logger: RecordingLogger;
  readonly resolver: CachingAclResolver;
}

function harness(overrides: { timeoutMs?: number } = {}): Harness {
  const ado = new FakeAdoClient(projects);
  const cache = new FakeCacheStore();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  const resolver = new CachingAclResolver({
    ado,
    cache,
    clock,
    logger,
    orgId: ORG_ID,
    ...(overrides.timeoutMs === undefined
      ? {}
      : { timeoutMs: overrides.timeoutMs }),
  });
  return { ado, cache, clock, logger, resolver };
}

describe('CachingAclResolver', () => {
  it('resolves readable projects and area paths', async () => {
    const { resolver } = harness();

    const acl = await resolver.resolve(identity, options);

    expect(acl.descriptor).toBe(TEST_DESCRIPTOR);
    expect(acl.readableProjectIds).toEqual(['Delivery', 'Platform']);
    expect(acl.readableAreaPaths).toEqual([
      'Delivery\\Data',
      'Delivery\\Web',
      'Delivery\\Web\\Shared',
      'Platform',
    ]);
  });

  it('probes under the caller identity, never the service one', async () => {
    const { ado, resolver } = harness();

    await resolver.resolve(identity, options);

    expect(ado.calls.length).toBeGreaterThan(0);
    expect(ado.calls.every((call) => call.authKind === 'user')).toBe(true);
    expect(ado.calls.every((call) => call.traceId === 'trace-acl')).toBe(true);
  });

  it('carries the configured timeout on every probe call', async () => {
    const { ado, resolver } = harness({ timeoutMs: 2_500 });

    await resolver.resolve(identity, options);

    expect(ado.calls.every((call) => call.timeoutMs === 2_500)).toBe(true);
  });

  it('caches the ACL for the 15 minutes the spec asks for', async () => {
    const { cache, resolver } = harness();

    const acl = await resolver.resolve(identity, options);

    expect(acl.expiresAt.getTime() - acl.resolvedAt.getTime()).toBe(ACL_TTL_MS);
    expect(ACL_TTL_MINUTES).toBe(15);
    expect(DEFAULT_CACHE_TTL_SECONDS.acl).toBe(ACL_TTL_MS / 1000);
    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0]?.ttl).toBe('acl');
    expect(cache.writes[0]?.key).toBe(cacheKeys.acl(ORG_ID, TEST_DESCRIPTOR));
  });

  it('serves the cached ACL without touching Azure DevOps again', async () => {
    const { ado, resolver } = harness();

    await resolver.resolve(identity, options);
    const callsAfterFirst = ado.calls.length;
    const second = await resolver.resolve(identity, options);

    expect(ado.calls).toHaveLength(callsAfterFirst);
    expect(second.readableProjectIds).toEqual(['Delivery', 'Platform']);
  });

  it('stores the ACL in a shape a stale reader cannot misread', async () => {
    const { cache, resolver } = harness();

    await resolver.resolve(identity, options);
    const stored = cache.entries.get(cacheKeys.acl(ORG_ID, TEST_DESCRIPTOR));

    expect(cachedAclSchema.safeParse(stored).success).toBe(true);
  });

  it('re-resolves once the cached ACL has expired', async () => {
    const { ado, clock, resolver } = harness();

    await resolver.resolve(identity, options);
    const callsAfterFirst = ado.calls.length;
    clock.advance(ACL_TTL_MS + 1_000);
    await resolver.resolve(identity, options);

    expect(ado.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('ignores a cached ACL belonging to somebody else', async () => {
    const { cache, resolver, ado } = harness();
    cache.entries.set(cacheKeys.acl(ORG_ID, TEST_DESCRIPTOR), {
      descriptor: 'aad.c29tZWJvZHk=',
      readableProjectIds: ['Everything'],
      writableProjectIds: ['Everything'],
      readableAreaPaths: [],
      writableAreaPaths: [],
      resolvedAt: '2026-09-17T09:00:00.000Z',
      expiresAt: '2026-09-17T09:15:00.000Z',
    });

    const acl = await resolver.resolve(identity, options);

    expect(acl.readableProjectIds).toEqual(['Delivery', 'Platform']);
    expect(ado.calls.length).toBeGreaterThan(0);
  });

  it('resolves once when two requests race for the same identity', async () => {
    const { ado, resolver } = harness();

    const [first, second] = await Promise.all([
      resolver.resolve(identity, options),
      resolver.resolve(identity, options),
    ]);

    expect(first).toEqual(second);
    expect(
      ado.calls.filter((call) => call.method === 'listProjects'),
    ).toHaveLength(1);
  });

  it('fails closed when the project probe fails', async () => {
    const broken = new FakeAdoClient(projects);
    broken.failures.set('listProjects', new UpstreamError('boom', 502));
    const cache = new FakeCacheStore();
    const failing = new CachingAclResolver({
      ado: broken,
      cache,
      clock: new TestClock(),
      logger: new RecordingLogger(),
      orgId: ORG_ID,
    });

    // No permissive fallback, no empty-but-valid ACL: the request dies.
    await expect(failing.resolve(identity, options)).rejects.toThrow(
      UpstreamError,
    );
    expect(cache.writes).toHaveLength(0);
  });

  it('does not cache a partial probe, so the next request retries', async () => {
    const ado = new FakeAdoClient(projects);
    ado.failures.set('listTeams', new UpstreamError('teams down', 502));
    const cache = new FakeCacheStore();
    const resolver = new CachingAclResolver({
      ado,
      cache,
      clock: new TestClock(),
      logger: new RecordingLogger(),
      orgId: ORG_ID,
    });

    const acl = await resolver.resolve(identity, options);

    expect(acl.readableProjectIds).toEqual(['Delivery', 'Platform']);
    expect(acl.readableAreaPaths).toEqual([]);
    expect(cache.writes).toHaveLength(0);
  });

  it('survives an unreachable cache by resolving live', async () => {
    const ado = new FakeAdoClient(projects);
    const cache = new FakeCacheStore();
    cache.failure = new Error('redis is gone');
    const logger = new RecordingLogger();
    const resolver = new CachingAclResolver({
      ado,
      cache,
      clock: new TestClock(),
      logger,
      orgId: ORG_ID,
    });

    const acl = await resolver.resolve(identity, options);

    expect(acl.readableProjectIds).toEqual(['Delivery', 'Platform']);
    expect(
      logger.lines.some((line) => line.message === 'acl cache write failed'),
    ).toBe(true);
  });

  it('never logs the caller access token', async () => {
    const { logger, resolver } = harness();

    await resolver.resolve(identity, options);

    expect(
      logger.everyValue().some((value) => value.includes(identity.accessToken)),
    ).toBe(false);
  });

  it('drops the cached ACL on invalidate, e.g. after a 403', async () => {
    const { cache, resolver, ado } = harness();

    await resolver.resolve(identity, options);
    await resolver.invalidate(TEST_DESCRIPTOR, options);
    const callsAfterFirst = ado.calls.length;
    await resolver.resolve(identity, options);

    expect(cache.deletes).toEqual([cacheKeys.acl(ORG_ID, TEST_DESCRIPTOR)]);
    expect(ado.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe('writable policies', () => {
  it('mirrors readable projects by default', async () => {
    const { resolver } = harness();

    const acl = await resolver.resolve(identity, options);

    expect(acl.writableProjectIds).toEqual(['Delivery', 'Platform']);
  });

  it('can make every project read-only', async () => {
    const resolver = new CachingAclResolver({
      ado: new FakeAdoClient(projects),
      cache: new FakeCacheStore(),
      clock: new TestClock(),
      logger: new RecordingLogger(),
      orgId: ORG_ID,
      writablePolicy: nothingWritable,
    });

    const acl = await resolver.resolve(identity, options);

    expect(acl.readableProjectIds).toHaveLength(2);
    expect(acl.writableProjectIds).toEqual([]);
  });

  it('never grants write outside what the caller can read', async () => {
    const resolver = new CachingAclResolver({
      ado: new FakeAdoClient(projects),
      cache: new FakeCacheStore(),
      clock: new TestClock(),
      logger: new RecordingLogger(),
      orgId: ORG_ID,
      writablePolicy: restrictWritableTo(['Delivery', 'Elsewhere']),
    });

    const acl = await resolver.resolve(identity, options);

    expect(acl.writableProjectIds).toEqual(['Delivery']);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return n * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
