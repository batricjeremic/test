import type { BoardSnapshot } from '@eg/shared';
import { describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  makeAcl,
  seedDeliveryBoard,
  TEST_BOARD_ID,
  type TestHarness,
} from './test-support.js';

const sprintUrl = (query = 'window=current'): string =>
  `/api/boards/${TEST_BOARD_ID}/sprint?${query}`;

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

const load = async (
  harness: TestHarness,
  query?: string,
): Promise<BoardSnapshot> => {
  const response = await harness.app.inject({
    url: sprintUrl(query),
    headers: bearer('reader-token'),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as BoardSnapshot;
};

describe('GET /api/boards/:boardId/sprint', () => {
  it('fans out, builds the board and resolves every card', async () => {
    await withBoard(async (harness) => {
      const snapshot = await load(harness);

      expect(snapshot.boardId).toBe(TEST_BOARD_ID);
      expect(snapshot.cards.map((card) => card.workItemId).sort()).toEqual([
        101, 102, 201,
      ]);
      // Cards land in the canonical column their team's mapping names.
      const checkout = snapshot.cards.find((card) => card.workItemId === 101);
      expect(checkout?.canonicalColumnId).toBe('col-doing');
      expect(checkout?.teamId).toBe('team-dev');
      expect(snapshot.teams).toHaveLength(2);
      expect(snapshot.cache).toMatchObject({ hit: false, degraded: false });
      expect(snapshot.traceId).toEqual(expect.any(String));
    });
  });

  it('serves the second load from the cache without re-reading', async () => {
    await withBoard(async (harness) => {
      await load(harness);
      const batches = harness.ado.count('getWorkItemsBatch');

      const second = await load(harness);

      expect(second.cache.hit).toBe(true);
      expect(harness.ado.count('getWorkItemsBatch')).toBe(batches);
    });
  });

  it('never lets a trimmed card reach the response', async () => {
    await withBoard(async (harness) => {
      harness.acl.acl = makeAcl({
        readableProjectIds: ['Delivery'],
        writableProjectIds: ['Delivery'],
      });

      const response = await harness.app.inject({
        url: sprintUrl(),
        headers: bearer('reader-token'),
      });
      const snapshot = response.json() as BoardSnapshot;

      expect(snapshot.cards.map((card) => card.workItemId)).not.toContain(201);
      // Not the id, and not a byte of the card's content either.
      expect(response.body).not.toContain('Ingestion backlog');
      // The lane stays, with a count, so a person knows something exists
      // without seeing what — the spec's own wording.
      expect(snapshot.hiddenCardCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.teams.map((team) => team.projectId)).toEqual([
        'Delivery',
      ]);
      expect(snapshot.permissions.readableProjectIds).toEqual(['Delivery']);
    });
  });

  it('trims the cached board too, not only the freshly built one', async () => {
    await withBoard(async (harness) => {
      // Warm the cache as a caller who may see everything.
      const full = await load(harness);
      expect(full.cards).toHaveLength(3);

      harness.acl.acl = makeAcl({ readableProjectIds: ['Data'] });
      const response = await harness.app.inject({
        url: sprintUrl(),
        headers: bearer('reader-token'),
      });
      const snapshot = response.json() as BoardSnapshot;

      expect(snapshot.cache.hit).toBe(true);
      expect(snapshot.cards.map((card) => card.workItemId)).toEqual([201]);
      expect(response.body).not.toContain('Checkout flow');
    });
  });

  it('honours the filter set', async () => {
    await withBoard(async (harness) => {
      const snapshot = await load(harness, 'window=current&projectIds=Data');

      expect(snapshot.cards.map((card) => card.workItemId)).toEqual([201]);
      expect(snapshot.filters.projectIds).toEqual(['Data']);
    });
  });

  it('keeps each alignment mode on its own cache entry', async () => {
    await withBoard(async (harness) => {
      await load(harness);
      const named = await load(
        harness,
        'window=named-iteration&iterationPath=Delivery%5CSprint%201',
      );

      expect(named.cache.hit).toBe(false);
      expect(named.alignment).toEqual({
        mode: 'named-iteration',
        iterationPath: 'Delivery\\Sprint 1',
      });
      // Board order: canonical column first, so To do precedes Doing.
      expect(named.cards.map((card) => card.workItemId)).toEqual([102, 101]);
    });
  });

  it('rejects a date window whose end precedes its start', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        url: sprintUrl('window=date-window&start=2026-09-20&end=2026-09-01'),
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('validation_failed');
    });
  });

  it('404s a board id the caller invented', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/boards/board-nope/sprint',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('not_found');
      expect(harness.ado.count('getWorkItemsBatch')).toBe(0);
    });
  });

  it('serves a degraded board when Redis is unreachable', async () => {
    await withBoard(async (harness) => {
      harness.redis.failure = new Error('redis is gone');

      const snapshot = await load(harness);

      expect(snapshot.cards).toHaveLength(3);
      expect(snapshot.cache).toMatchObject({ hit: false, degraded: true });
      expect(snapshot.realtime.mode).toBe('polling');
    });
  });

  it('records the work items on the board for the webhook to find', async () => {
    await withBoard(async (harness) => {
      await load(harness);

      const indexed = [...harness.redis.values.keys()].filter((key) =>
        key.includes(':workitem:'),
      );
      expect(indexed).toHaveLength(3);
    });
  });
});
