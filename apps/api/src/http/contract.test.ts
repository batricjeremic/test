/**
 * The seam nothing else could see.
 *
 * Every other test here asserts the API against expectations written in
 * this package, and every hub test runs against a fake client written in
 * that one. Both suites were green while the two sides disagreed about
 * five endpoints at once: four collections were wrapped in an envelope
 * the hub never unwrapped, the mapping table took one row where the hub
 * sent the whole matrix, a board update was PATCH on one side and PUT on
 * the other, and `/person-overrides` did not exist at all — which is what
 * a real browser found on the first click, as "That route does not
 * exist".
 *
 * So these tests parse the API's real responses with the very Zod schemas
 * the hub's client parses them with, imported from `@eg/shared`. A shape
 * disagreement is then a failing test rather than a screenshot.
 *
 * This still cannot catch a case where both sides are wrong about the
 * OUTSIDE world — see ADR 0007. It catches only the case where we
 * disagree with ourselves, which is the one we kept shipping.
 */
import {
  boardDefinitionSchema,
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  personOverrideSchema,
} from '@eg/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bearer,
  buildTestApp,
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

/** Exactly what `apps/hub/src/api/client.ts` parses each body with. */
const READ_CONTRACT = [
  {
    what: 'the board list',
    url: '/api/boards',
    schema: z.array(boardDefinitionSchema),
  },
  {
    what: 'one board definition',
    url: `/api/boards/${TEST_BOARD_ID}`,
    schema: boardDefinitionSchema,
  },
  {
    what: 'the board sources',
    url: `/api/boards/${TEST_BOARD_ID}/sources`,
    schema: z.array(boardSourceSchema),
  },
  {
    what: 'the canonical columns',
    url: `/api/boards/${TEST_BOARD_ID}/columns`,
    schema: z.array(canonicalColumnSchema),
  },
  {
    what: 'the column mappings',
    url: `/api/boards/${TEST_BOARD_ID}/mappings`,
    schema: z.array(columnMappingSchema),
  },
  {
    what: 'the person overrides',
    url: `/api/boards/${TEST_BOARD_ID}/person-overrides`,
    schema: z.array(personOverrideSchema),
  },
] as const;

describe('the shape the hub actually parses', () => {
  for (const route of READ_CONTRACT) {
    it(`GET ${route.url} answers with ${route.what}`, async () => {
      await withBoard(async (harness) => {
        const response = await harness.app.inject({
          url: route.url,
          headers: bearer('owner-token'),
        });

        expect(response.statusCode).toBe(200);
        // Not toMatchObject: the point is that the hub's own parse
        // succeeds on the whole body, envelope and all.
        const parsed = route.schema.safeParse(response.json());
        expect(parsed.success ? null : parsed.error.issues).toBeNull();
      });
    });
  }

  it('replaces the whole mapping table, not one row', async () => {
    await withBoard(async (harness) => {
      const before = await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/mappings`,
        headers: bearer('owner-token'),
      });
      const existing = z.array(columnMappingSchema).parse(before.json());
      expect(existing.length).toBeGreaterThan(1);

      // The hub sends the matrix it has, which is how a mapping is
      // removed. An upsert-one endpoint could never express this.
      const kept = existing.slice(0, 1);
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/mappings`,
        headers: bearer('owner-token'),
        payload: kept,
      });

      expect(response.statusCode).toBe(200);
      expect(z.array(columnMappingSchema).parse(response.json())).toEqual(kept);
    });
  });

  it('round-trips person overrides', async () => {
    await withBoard(async (harness) => {
      const overrides = [
        {
          boardId: TEST_BOARD_ID,
          descriptor: 'aad.ana',
          displayName: 'Ana (contract)',
          hidden: false,
        },
      ];

      const written = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}/person-overrides`,
        headers: bearer('owner-token'),
        payload: overrides,
      });
      expect(written.statusCode).toBe(200);

      const read = await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/person-overrides`,
        headers: bearer('owner-token'),
      });
      expect(z.array(personOverrideSchema).parse(read.json())).toEqual(
        overrides,
      );
    });
  });

  it('updates a board through PUT, which is what the hub sends', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/boards/${TEST_BOARD_ID}`,
        headers: bearer('owner-token'),
        payload: {
          name: 'Renamed by contract test',
          defaultGrouping: 'team',
          ownerDescriptor: 'aad.owner',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(boardDefinitionSchema.parse(response.json())).toMatchObject({
        name: 'Renamed by contract test',
        defaultGrouping: 'team',
      });
    });
  });
});
