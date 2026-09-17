import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import {
  createContainer,
  deriveOrgId,
  parseWebhookAuth,
  systemClock,
} from './container.js';
import { ConfigError } from './errors.js';
import {
  FakeAclResolver,
  FakeAdoClient,
  FakeConfigStore,
  FakePublisher,
  FakeTokenVerifier,
  TEST_ENV,
  testClock,
} from './http/test-support.js';
import { FakeRedis } from './cache/test-support.js';
import { createRedisCache } from './cache/index.js';
import { RecordingLogger } from './realtime/test-support.js';

const config = parseConfig(TEST_ENV);

const fakeContainer = () => {
  const logger = new RecordingLogger();
  const clock = testClock();
  return createContainer({
    config,
    enableSync: false,
    overrides: {
      logger,
      clock,
      ado: new FakeAdoClient(),
      config: new FakeConfigStore(),
      cache: createRedisCache({
        client: new FakeRedis(),
        logger,
        commandTimeoutMs: 50,
      }),
      acl: new FakeAclResolver(),
      verifier: new FakeTokenVerifier(),
      realtime: new FakePublisher(),
      webhookAuth: null,
    },
  });
};

describe('deriveOrgId', () => {
  it('reads the organisation out of the Azure DevOps URL', () => {
    expect(deriveOrgId('https://dev.azure.com/expertgroup')).toBe(
      'expertgroup',
    );
    expect(deriveOrgId('https://dev.azure.com/expertgroup/')).toBe(
      'expertgroup',
    );
    expect(deriveOrgId('https://expertgroup.visualstudio.com')).toBe(
      'expertgroup',
    );
  });

  it('falls back to the raw value rather than throwing', () => {
    expect(deriveOrgId('not a url')).toBe('not a url');
  });
});

describe('parseWebhookAuth', () => {
  it('is null when no service hook credentials are configured', () => {
    expect(parseWebhookAuth({})).toBeNull();
  });

  it('reads a basic credential', () => {
    expect(
      parseWebhookAuth({
        WEBHOOK_BASIC_USERNAME: 'hooks',
        WEBHOOK_BASIC_PASSWORD: 'a-long-enough-password',
      }),
    ).toEqual({
      kind: 'basic',
      username: 'hooks',
      password: 'a-long-enough-password',
    });
  });

  it('reads a shared secret header', () => {
    expect(
      parseWebhookAuth({
        WEBHOOK_SECRET_HEADER: 'x-eg-hook',
        WEBHOOK_SHARED_SECRET: 'sixteen-characters-at-least',
      }),
    ).toMatchObject({ kind: 'shared-secret', headerName: 'x-eg-hook' });
  });

  it('refuses half a credential, without echoing it', () => {
    expect(() => parseWebhookAuth({ WEBHOOK_BASIC_USERNAME: 'hooks' })).toThrow(
      ConfigError,
    );
    try {
      parseWebhookAuth({ WEBHOOK_BASIC_PASSWORD: 'short' });
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('short');
    }
  });
});

describe('createContainer', () => {
  it('uses every override instead of building a real client', async () => {
    const container = fakeContainer();

    expect(container.ports.ado).toBeInstanceOf(FakeAdoClient);
    expect(container.ports.config).toBeInstanceOf(FakeConfigStore);
    expect(container.orgId).toBe('expertgroup');
    expect(container.hub).toBeNull();
    expect(container.sync).toBeNull();
    await container.shutdown('test');
  });

  it('shuts down once, however often it is asked', async () => {
    const container = fakeContainer();
    container.start();

    await container.shutdown('first');
    await container.shutdown('second');

    const logger = container.ports.logger as RecordingLogger;
    expect(logger.matching('container stopped')).toHaveLength(1);
  });

  it('exposes the system clock as the Clock port', () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
  });
});
