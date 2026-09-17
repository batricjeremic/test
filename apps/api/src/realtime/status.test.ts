import { describe, expect, it } from 'vitest';
import { DEFAULT_POLL_INTERVAL_SECONDS } from '@eg/shared';
import { realtimeStatusFor, ServiceHookRegistry } from './status.js';
import { RecordingLogger } from './test-support.js';

const registryWith = (projectIds: readonly string[]): ServiceHookRegistry => {
  const registry = new ServiceHookRegistry(new RecordingLogger());
  for (const projectId of projectIds) {
    registry.markSubscribed(projectId, `sub-${projectId}`);
  }
  return registry;
};

describe('ServiceHookRegistry', () => {
  it('reports the projects with no subscription', () => {
    const registry = registryWith(['p1']);
    expect(registry.has('p1')).toBe(true);
    expect(registry.missing(['p1', 'p2'])).toEqual(['p2']);
    expect(registry.subscribedProjectIds).toEqual(['p1']);
  });

  it('drops a project whose subscription is gone', () => {
    const logger = new RecordingLogger();
    const registry = new ServiceHookRegistry(logger);
    registry.markSubscribed('p1', 'sub-1');
    registry.markUnsubscribed('p1');
    registry.markUnsubscribed('p1');

    expect(registry.has('p1')).toBe(false);
    expect(logger.matching('service hook subscription lost')).toHaveLength(1);
  });
});

describe('realtimeStatusFor', () => {
  it('is live when every project is covered and the cache is serving', () => {
    expect(
      realtimeStatusFor({
        channel: 'board:board-1',
        projectIds: ['p1', 'p2'],
        hooks: registryWith(['p1', 'p2']),
        cacheHealthy: true,
      }),
    ).toEqual({
      mode: 'live',
      channel: 'board:board-1',
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      reason: null,
    });
  });

  it('falls back to polling, visibly, when a project has no hook', () => {
    const status = realtimeStatusFor({
      channel: 'board:board-1',
      projectIds: ['p1', 'p2'],
      hooks: registryWith(['p1']),
      cacheHealthy: true,
    });

    expect(status.mode).toBe('polling');
    expect(status.reason).toBe('service-hooks-missing');
    expect(status.pollIntervalSeconds).toBe(30);
  });

  it('names the cache when hooks are fine but Redis is not', () => {
    const status = realtimeStatusFor({
      channel: 'board:board-1',
      projectIds: ['p1'],
      hooks: registryWith(['p1']),
      cacheHealthy: false,
    });

    expect(status).toMatchObject({
      mode: 'polling',
      reason: 'cache-unavailable',
    });
  });

  it('reports a client that asked to poll', () => {
    const status = realtimeStatusFor({
      channel: 'board:board-1',
      projectIds: [],
      hooks: registryWith([]),
      cacheHealthy: true,
      clientFallback: true,
      pollIntervalSeconds: 45,
    });

    expect(status).toEqual({
      mode: 'polling',
      channel: 'board:board-1',
      pollIntervalSeconds: 45,
      reason: 'client-fallback',
    });
  });
});
