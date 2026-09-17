import { describe, expect, it } from 'vitest';
import type { AdoWorkItemUpdatedEvent } from '../ado/types.js';
import { WORK_ITEM_HOOK_PATH, type WebhookAuth } from '../realtime/index.js';
import {
  bearer,
  buildTestApp,
  seedDeliveryBoard,
  TEST_BOARD_ID,
  type TestHarness,
} from './test-support.js';

const HOOK_AUTH: WebhookAuth = {
  kind: 'basic',
  username: 'ado-hooks',
  password: 'a-long-enough-password',
};

const basic = (password = HOOK_AUTH.password): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(
    `${HOOK_AUTH.username}:${password}`,
  ).toString('base64')}`,
});

const withHook = async (
  body: (harness: TestHarness) => Promise<void>,
): Promise<void> => {
  const harness = await buildTestApp({ webhookAuth: HOOK_AUTH });
  seedDeliveryBoard(harness);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

const event = (workItemId: number): AdoWorkItemUpdatedEvent => ({
  eventType: 'workitem.updated',
  resource: { id: 9001, workItemId, rev: 8, fields: {} },
});

describe('POST /api/hooks/workitem-updated', () => {
  it('accepts a signed delivery, invalidates and pushes the delta', async () => {
    await withHook(async (harness) => {
      // Warm the board, which is what leaves the work item -> board index.
      await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/sprint`,
        headers: bearer('reader-token'),
      });
      const snapshots = () =>
        [...harness.redis.values.keys()].filter((key) =>
          key.includes(':snapshot:'),
        );
      expect(snapshots()).toHaveLength(1);

      const response = await harness.app.inject({
        method: 'POST',
        url: WORK_ITEM_HOOK_PATH,
        headers: basic(),
        payload: event(101),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true });

      await harness.container.webhookQueue.drain();

      expect(snapshots()).toHaveLength(0);
      expect(harness.publisher.published).toHaveLength(1);
      expect(harness.publisher.published[0]).toMatchObject({
        boardId: TEST_BOARD_ID,
        origin: 'service-hook',
        delta: { kind: 'card-upserted', card: { workItemId: 101 } },
      });
    });
  });

  it('refuses a delivery with the wrong credentials', async () => {
    await withHook(async (harness) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: WORK_ITEM_HOOK_PATH,
        headers: basic('not-the-password'),
        payload: event(101),
      });

      expect(response.statusCode).toBe(401);
      expect(harness.publisher.published).toHaveLength(0);
    });
  });

  it('is not mounted when no credentials are configured', async () => {
    const harness = await buildTestApp();
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: WORK_ITEM_HOOK_PATH,
        payload: event(101),
      });
      // No route at all, rather than a route that accepts anything.
      expect(response.statusCode).toBe(404);
      expect(
        harness.logger.matching('service hook webhook is not mounted'),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
