import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { TEST_ENV } from './http/test-support.js';
import { RecordingLogger } from './realtime/test-support.js';
import {
  installSignalHandlers,
  isCliEntrypoint,
  SHUTDOWN_SIGNALS,
  startServer,
  type RunningServer,
} from './server.js';

/**
 * These start the real process surface — a listener on an ephemeral port,
 * the real container — but nothing connects: ioredis is lazy, pg connects
 * on first query, and no request is made.
 */
const config = parseConfig(TEST_ENV);

describe('startServer', () => {
  it('listens and then shuts down gracefully', async () => {
    const logger = new RecordingLogger();
    const server = await startServer({
      config,
      env: TEST_ENV,
      host: '127.0.0.1',
      port: 0,
      logger,
      drainTimeoutMs: 1_000,
    });

    expect(server.address).toContain('127.0.0.1');
    const health = await server.app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);

    await server.close('test');

    expect(logger.matching('shutdown complete')).toHaveLength(1);
    expect(logger.matching('container stopped')).toHaveLength(1);
  });

  it('closes once, however many signals arrive', async () => {
    const logger = new RecordingLogger();
    const server = await startServer({
      config,
      env: TEST_ENV,
      host: '127.0.0.1',
      port: 0,
      logger,
    });

    await Promise.all([server.close('SIGTERM'), server.close('SIGINT')]);

    expect(logger.matching('shutdown started')).toHaveLength(1);
  });
});

describe('installSignalHandlers', () => {
  it('wires both signals and can detach again', () => {
    const closed: string[] = [];
    const fake = {
      close: async (reason?: string) => {
        closed.push(reason ?? 'none');
      },
    } as unknown as RunningServer;
    const before = SHUTDOWN_SIGNALS.map((signal) =>
      process.listenerCount(signal),
    );

    const detach = installSignalHandlers(fake, new RecordingLogger());
    const during = SHUTDOWN_SIGNALS.map((signal) =>
      process.listenerCount(signal),
    );
    detach();
    const after = SHUTDOWN_SIGNALS.map((signal) =>
      process.listenerCount(signal),
    );

    expect(during).toEqual(before.map((count) => count + 1));
    expect(after).toEqual(before);
  });
});

describe('isCliEntrypoint', () => {
  it('is false when something else started the process', () => {
    expect(isCliEntrypoint(['node', '/somewhere/else/vitest.js'])).toBe(false);
    expect(isCliEntrypoint(['node'])).toBe(false);
  });
});
