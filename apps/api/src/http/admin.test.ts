import { describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  DEV_BOARD,
  seedDeliveryBoard,
  TEST_BOARD_ID,
  type TestHarness,
} from './test-support.js';

const withBoard = async (
  body: (harness: TestHarness) => Promise<void>,
): Promise<void> => {
  const harness = await buildTestApp();
  seedDeliveryBoard(harness);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

const warmSnapshot = async (harness: TestHarness): Promise<void> => {
  await harness.app.inject({
    url: `/api/boards/${TEST_BOARD_ID}/sprint`,
    headers: bearer('reader-token'),
  });
};

const snapshotKeys = (harness: TestHarness): string[] =>
  [...harness.redis.values.keys()].filter((key) => key.includes(':snapshot:'));

describe('admin routes', () => {
  it('lists the organisation boards to any authenticated caller', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/boards',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().boards).toHaveLength(1);
    });
  });

  it('makes the creator the owner and ignores a supplied one', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/boards',
        headers: bearer('reader-token'),
        payload: {
          name: 'Platform',
          defaultGrouping: 'team',
          ownerDescriptor: 'aad.someone-else',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        name: 'Platform',
        defaultGrouping: 'team',
        ownerDescriptor: 'aad.reader',
      });
    });
  });

  it('lets only the owner change a board', async () => {
    await withBoard(async (harness) => {
      const refused = await harness.app.inject({
        method: 'PATCH',
        url: `/api/boards/${TEST_BOARD_ID}`,
        headers: bearer('reader-token'),
        payload: { name: 'Renamed by a stranger' },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('permission_denied');

      const allowed = await harness.app.inject({
        method: 'PATCH',
        url: `/api/boards/${TEST_BOARD_ID}`,
        headers: bearer('owner-token'),
        payload: { name: 'Delivery — every division' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().name).toBe('Delivery — every division');
    });
  });

  it('invalidates the board when the mapping changes', async () => {
    await withBoard(async (harness) => {
      await warmSnapshot(harness);
      expect(snapshotKeys(harness)).toHaveLength(1);

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/mappings`,
        headers: bearer('owner-token'),
        payload: {
          teamId: 'team-data',
          sourceColumnId: `${DEV_BOARD}-col-2`,
          canonicalColumnId: 'col-done',
          targetState: 'Closed',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.config.mappings).toHaveLength(6);
      expect(snapshotKeys(harness)).toHaveLength(0);
    });
  });

  it('replaces the canonical columns and drops the stale board', async () => {
    await withBoard(async (harness) => {
      await warmSnapshot(harness);

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/columns`,
        headers: bearer('owner-token'),
        payload: {
          columns: [
            {
              id: 'col-todo',
              name: 'To do',
              order: 0,
              stateCategory: 'Proposed',
            },
            {
              id: 'col-done',
              name: 'Done',
              order: 1,
              stateCategory: 'Completed',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().columns).toHaveLength(2);
      expect(snapshotKeys(harness)).toHaveLength(0);
    });
  });

  it('replaces the sources and flushes the team board columns', async () => {
    await withBoard(async (harness) => {
      await warmSnapshot(harness);
      const columnKeys = () =>
        [...harness.redis.values.keys()].filter((key) =>
          key.endsWith(':columns'),
        );
      expect(columnKeys().length).toBeGreaterThan(0);

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/sources`,
        headers: bearer('owner-token'),
        payload: {
          sources: [
            {
              projectId: 'Delivery',
              teamId: 'team-dev',
              backlogLevel: 'Microsoft.RequirementCategory',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().sources).toHaveLength(1);
      expect(columnKeys()).toHaveLength(0);
      expect(snapshotKeys(harness)).toHaveLength(0);
    });
  });

  it('counts the unmapped columns for the mapping screen', async () => {
    await withBoard(async (harness) => {
      // Strand a card: drop the mapping row its column resolves through.
      harness.config.mappings = harness.config.mappings.filter(
        (mapping) => mapping.canonicalColumnId !== 'col-doing',
      );

      const response = await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/unmapped`,
        headers: bearer('owner-token'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        boardId: TEST_BOARD_ID,
        unmappedCardCount: 1,
        cardCount: 3,
      });
      expect(response.json().unmappedColumns).toEqual([
        expect.objectContaining({
          projectId: 'Delivery',
          teamId: 'team-dev',
          sourceColumn: 'Doing',
          cardCount: 1,
        }),
      ]);
    });
  });

  it('keeps the unmapped count away from a non-owner', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/unmapped`,
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  it('validates an admin body', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/mappings`,
        headers: bearer('owner-token'),
        payload: { teamId: '', sourceColumnId: 'x', canonicalColumnId: 'y' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'validation_failed' });
      expect(response.json().details).toBeDefined();
    });
  });

  it('deletes a mapping row', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        method: 'DELETE',
        url: `/api/boards/${TEST_BOARD_ID}/mappings/team-dev/${DEV_BOARD}-col-1`,
        headers: bearer('owner-token'),
      });

      expect(response.statusCode).toBe(204);
      expect(
        harness.config.mappings.some(
          (mapping) => mapping.sourceColumnId === `${DEV_BOARD}-col-1`,
        ),
      ).toBe(false);
    });
  });
});
