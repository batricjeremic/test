import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEALTH_PATH, READY_PATH } from './health.js';
import { BOARD_SPRINT_PATH } from './boards.js';
import {
  bearer,
  buildTestApp,
  seedDeliveryBoard,
  TEST_BOARD_ID,
  type TestHarness,
} from './test-support.js';

const SPRINT_URL = `/api/boards/${TEST_BOARD_ID}/sprint?window=current`;

const withApp = async (
  body: (harness: TestHarness) => Promise<void>,
): Promise<void> => {
  const harness = await buildTestApp();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

describe('buildApp', () => {
  it('refuses an unauthenticated request with a typed 401', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({ url: SPRINT_URL });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: 'unauthorized',
        status: 401,
      });
      expect(response.json().traceId).toEqual(expect.any(String));
      // Nothing was read on the caller's behalf.
      expect(harness.ado.callCount).toBe(0);
    });
  });

  it('refuses a token the issuer does not recognise', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: SPRINT_URL,
        headers: bearer('forged-token'),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('unauthorized');
    });
  });

  it('adopts an inbound correlation id and echoes it', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: HEALTH_PATH,
        headers: { 'x-trace-id': 'trace-from-the-hub' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-trace-id']).toBe('trace-from-the-hub');
      expect(response.json().traceId).toBe('trace-from-the-hub');
    });
  });

  it('mints a correlation id when the caller sends none', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({ url: HEALTH_PATH });

      expect(response.headers['x-trace-id']).toEqual(expect.any(String));
      expect(String(response.headers['x-trace-id']).length).toBeGreaterThan(8);
    });
  });

  it('answers an unknown route in the ApiError shape', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/nope',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    });
  });

  it('does not tell an anonymous caller which routes exist', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({ url: '/api/nope' });

      expect(response.statusCode).toBe(401);
    });
  });

  it('never leaks an internal message or a secret from a 500', async () => {
    await withApp(async (harness) => {
      seedDeliveryBoard(harness);
      const secret = 'postgres://user:hunter2-token@db.internal:5432/board';
      harness.config.listFailure = new Error(`connect failed: ${secret}`);

      const response = await harness.app.inject({
        url: '/api/boards',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: 'internal_error',
        message: 'Something went wrong.',
      });
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('db.internal');
      // And it stays out of the logs, because it is not our message.
      const logged = JSON.stringify(harness.logger.lines);
      expect(logged).not.toContain('hunter2');
      expect(logged).not.toContain('db.internal');
    });
  });

  it('bounds the request body', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/moves',
        headers: bearer('reader-token'),
        payload: { boardId: 'x'.repeat(400_000) },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().code).toBe('validation_failed');
    });
  });

  it('allows the Azure DevOps origin and refuses another', async () => {
    await withApp(async (harness) => {
      const allowed = await harness.app.inject({
        url: HEALTH_PATH,
        headers: { origin: 'https://dev.azure.com' },
      });
      const refused = await harness.app.inject({
        url: HEALTH_PATH,
        headers: { origin: 'https://evil.example.com' },
      });

      expect(allowed.headers['access-control-allow-origin']).toBe(
        'https://dev.azure.com',
      );
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  it('reports readiness honestly, degraded apart from down', async () => {
    await withApp(async (harness) => {
      const ready = await harness.app.inject({ url: READY_PATH });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: 'ready',
        components: { postgres: 'up', redis: 'up' },
      });

      // Redis down: still serving, from Azure DevOps directly.
      harness.redis.failure = new Error('redis is gone');
      await harness.cache.get('eg:v1:health:probe', z.string(), {
        traceId: 'probe',
      });
      const degraded = await harness.app.inject({ url: READY_PATH });
      expect(degraded.statusCode).toBe(200);
      expect(degraded.json()).toMatchObject({
        status: 'degraded',
        components: { postgres: 'up', redis: 'down' },
      });

      // Postgres down: nothing can be served or audited.
      harness.config.listFailure = new Error('no database');
      const down = await harness.app.inject({ url: READY_PATH });
      expect(down.statusCode).toBe(503);
      expect(down.json().status).toBe('unavailable');
    });
  });

  it('serves health without a token', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({ url: HEALTH_PATH });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('ok');
    });
  });

  it('mounts the board read route', async () => {
    await withApp(async (harness) => {
      seedDeliveryBoard(harness);
      const response = await harness.app.inject({
        url: SPRINT_URL,
        headers: bearer('reader-token'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().boardId).toBe(TEST_BOARD_ID);
    });
  });
});

describe('route table', () => {
  it('exposes the spec route', () => {
    expect(BOARD_SPRINT_PATH).toBe('/api/boards/:boardId/sprint');
  });
});
