/**
 * The admin surface: board definitions, their sources, the canonical
 * columns and the per-team column mapping.
 *
 * Spec, "Domain model and column mapping": "An admin picks the projects
 * and teams it covers, declares canonical columns once, and maps each
 * team's own columns onto them." And: "Unmapped columns are not guessed
 * ... the admin screen shows a count", which is `GET .../unmapped`.
 *
 * Every write is guarded on the board's owner, and every write drops the
 * cache entries the spec's table says it invalidates — the mapping has no
 * TTL, so an admin change that did not invalidate would never be seen.
 */
import {
  boardGroupingSchema,
  columnMappingSchema,
  nonEmptyStringSchema,
  personOverrideSchema,
  stateCategorySchema,
} from '@eg/shared';
import type {
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/plugin.js';
import type { CacheInvalidator, TeamScope } from '../cache/index.js';
import { unmappedCardCount } from '../domain/index.js';
import { PermissionDeniedError } from '../errors.js';
import type { CallerAcl, CallOptions, ConfigStore, Logger } from '../ports.js';
import type { BoardReadService } from './board-service.js';
import { loadBoardDefinition } from './board-context.js';
import { parseWith, requestLogger } from './context.js';
import { parseBoardIdParam, parseSnapshotQuery } from './query.js';

export const BOARDS_PATH = '/api/boards';

export interface AdminRouteOptions {
  readonly config: ConfigStore;
  readonly invalidator: CacheInvalidator;
  readonly boards: BoardReadService;
  readonly orgId: string;
  readonly logger: Logger;
}

/* ------------------------------------------------------------------ */
/* Bodies                                                              */
/* ------------------------------------------------------------------ */

export const createBoardBodySchema = z.object({
  name: nonEmptyStringSchema,
  defaultGrouping: boardGroupingSchema.default('person'),
});

export const patchBoardBodySchema = z
  .object({
    name: nonEmptyStringSchema.optional(),
    defaultGrouping: boardGroupingSchema.optional(),
    ownerDescriptor: nonEmptyStringSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be set',
  });

/**
 * Collection bodies are bare arrays, and collection responses are bare
 * arrays, because that is what the hub sends and parses. They used to be
 * wrapped (`{ sources: [...] }`) on this side only, which no test on
 * either side could see: the hub's tests use a fake client and the API's
 * use `inject` against expectations written here. See the contract test
 * in `contract.test.ts`, which parses these responses with the very
 * schemas the hub parses them with.
 *
 * `boardId` is taken from the path and never from the body, so a body
 * naming a different board cannot write across boards.
 */
/** The whole definition, as the hub's `updateBoardDefinition` sends it. */
export const putBoardBodySchema = z.object({
  name: nonEmptyStringSchema,
  defaultGrouping: boardGroupingSchema,
  ownerDescriptor: nonEmptyStringSchema,
});

export const boardSourcesBodySchema = z.array(
  z.object({
    projectId: nonEmptyStringSchema,
    teamId: nonEmptyStringSchema,
    backlogLevel: nonEmptyStringSchema,
  }),
);

export const canonicalColumnsBodySchema = z.array(
  z.object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    order: z.number().int().nonnegative(),
    stateCategory: stateCategorySchema,
  }),
);

export const columnMappingsBodySchema = z.array(
  columnMappingSchema.omit({ boardId: true }),
);

export const personOverridesBodySchema = z.array(
  personOverrideSchema.omit({ boardId: true }),
);

export const columnMappingBodySchema = z.object({
  teamId: nonEmptyStringSchema,
  sourceColumnId: nonEmptyStringSchema,
  canonicalColumnId: nonEmptyStringSchema,
  targetState: z.string().min(1).nullable().default(null),
});

const mappingParamsSchema = z.object({
  boardId: nonEmptyStringSchema,
  teamId: nonEmptyStringSchema,
  sourceColumnId: nonEmptyStringSchema,
});

/* ------------------------------------------------------------------ */
/* Guard                                                               */
/* ------------------------------------------------------------------ */

/**
 * Only the board's owner may reconfigure it. Read access to a board's
 * configuration is not the same right: the hub needs the columns to
 * render, the mapping screen needs the owner.
 */
export function assertBoardAdmin(
  definition: BoardDefinition,
  acl: CallerAcl,
): void {
  if (acl.descriptor !== definition.ownerDescriptor) {
    throw new PermissionDeniedError(
      `Caller does not own board ${definition.id}`,
      { details: { boardId: definition.id } },
    );
  }
}

const scopesOf = (
  orgId: string,
  sources: readonly BoardSource[],
): TeamScope[] =>
  sources.map((source) => ({
    orgId,
    projectId: source.projectId,
    teamId: source.teamId,
  }));

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function adminRoutes(
  app: FastifyInstance,
  options: AdminRouteOptions,
): Promise<void> {
  const { config, invalidator } = options;

  const owned = async (
    boardId: string,
    acl: CallerAcl,
    call: CallOptions,
  ): Promise<BoardDefinition> => {
    const definition = await loadBoardDefinition(config, boardId, call);
    assertBoardAdmin(definition, acl);
    return definition;
  };

  app.get(BOARDS_PATH, async (request, reply) => {
    const auth = requireAuth(request);
    const definitions = await config.listBoardDefinitions(
      options.orgId,
      auth.callOptions(),
    );
    return reply.send(definitions);
  });

  app.post(BOARDS_PATH, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseWith(createBoardBodySchema, request.body, 'board');
    // The creator owns the board; a client-supplied owner is ignored.
    const created = await config.createBoardDefinition(
      {
        name: body.name,
        orgId: options.orgId,
        defaultGrouping: body.defaultGrouping,
        ownerDescriptor: auth.identity.descriptor,
      },
      auth.callOptions(),
    );
    requestLogger(request, options.logger).info('board definition created', {
      boardId: created.id,
      descriptor: created.ownerDescriptor,
    });
    return reply.code(201).send(created);
  });

  app.get(`${BOARDS_PATH}/:boardId`, async (request, reply) => {
    const auth = requireAuth(request);
    const boardId = parseBoardIdParam(request.params);
    const definition = await loadBoardDefinition(
      config,
      boardId,
      auth.callOptions(),
    );
    return reply.send(definition);
  });

  /**
   * The whole definition, which is what the hub sends after editing a
   * board's name or grouping. `id` and `orgId` come from the path and the
   * deployment, so the body cannot move a board to another organisation.
   */
  app.put(`${BOARDS_PATH}/:boardId`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const body = parseWith(
      putBoardBodySchema,
      request.body,
      'board definition',
    );
    await owned(boardId, await auth.acl(), call);
    const updated = await config.updateBoardDefinition(
      boardId,
      {
        name: body.name,
        defaultGrouping: body.defaultGrouping,
        ownerDescriptor: body.ownerDescriptor,
      },
      call,
    );
    await invalidator.invalidateBoard(boardId, call);
    return reply.send(updated);
  });

  app.patch(`${BOARDS_PATH}/:boardId`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const patch = parseWith(patchBoardBodySchema, request.body, 'board patch');
    await owned(boardId, await auth.acl(), call);
    const updated = await config.updateBoardDefinition(boardId, patch, call);
    await invalidator.invalidateBoard(boardId, call);
    return reply.send(updated);
  });

  app.delete(`${BOARDS_PATH}/:boardId`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await owned(boardId, await auth.acl(), call);
    await config.deleteBoardDefinition(boardId, call);
    await invalidator.invalidateBoard(boardId, call);
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Sources                                                           */
  /* ---------------------------------------------------------------- */

  app.get(`${BOARDS_PATH}/:boardId/sources`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await loadBoardDefinition(config, boardId, call);
    return reply.send(await config.listBoardSources(boardId, call));
  });

  app.put(`${BOARDS_PATH}/:boardId/sources`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const body = parseWith(
      boardSourcesBodySchema,
      request.body,
      'board sources',
    );
    await owned(boardId, await auth.acl(), call);

    const previous = await config.listBoardSources(boardId, call);
    const sources: BoardSource[] = body.map((source) => ({
      ...source,
      boardId,
    }));
    const saved = await config.replaceBoardSources(boardId, sources, call);
    // Team boards and their columns are re-read for the new source set.
    await invalidator.flushBoardColumns(
      boardId,
      scopesOf(options.orgId, [...previous, ...saved]),
      call,
    );
    await invalidator.invalidateBoard(boardId, call);
    return reply.send(saved);
  });

  /* ---------------------------------------------------------------- */
  /* Canonical columns                                                 */
  /* ---------------------------------------------------------------- */

  app.get(`${BOARDS_PATH}/:boardId/columns`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await loadBoardDefinition(config, boardId, call);
    return reply.send(await config.listCanonicalColumns(boardId, call));
  });

  app.put(`${BOARDS_PATH}/:boardId/columns`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const body = parseWith(
      canonicalColumnsBodySchema,
      request.body,
      'canonical columns',
    );
    await owned(boardId, await auth.acl(), call);
    const columns: CanonicalColumn[] = body.map((column) => ({
      ...column,
      boardId,
    }));
    const saved = await config.replaceCanonicalColumns(boardId, columns, call);
    await invalidator.invalidateBoard(boardId, call);
    return reply.send(saved);
  });

  /* ---------------------------------------------------------------- */
  /* Column mapping                                                    */
  /* ---------------------------------------------------------------- */

  app.get(`${BOARDS_PATH}/:boardId/mappings`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await loadBoardDefinition(config, boardId, call);
    return reply.send(await config.listColumnMappings(boardId, call));
  });

  /**
   * The whole mapping table, replaced in one transaction. The mapping
   * screen edits a matrix and saves it whole; sending N upserts would
   * leave a half-mapped board visible to everyone else if the tab closed
   * in the middle, and would give no way to remove a mapping.
   */
  app.put(`${BOARDS_PATH}/:boardId/mappings`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const body = parseWith(
      columnMappingsBodySchema,
      request.body,
      'column mappings',
    );
    await owned(boardId, await auth.acl(), call);
    const mappings: ColumnMapping[] = body.map((mapping) => ({
      ...mapping,
      boardId,
    }));
    const saved = await config.replaceColumnMappings(boardId, mappings, call);
    await invalidator.invalidateBoard(boardId, call);
    return reply.send(saved);
  });

  app.delete(
    `${BOARDS_PATH}/:boardId/mappings/:teamId/:sourceColumnId`,
    async (request, reply) => {
      const auth = requireAuth(request);
      const call = auth.callOptions();
      const params = parseWith(
        mappingParamsSchema,
        request.params,
        'mapping key',
      );
      await owned(params.boardId, await auth.acl(), call);
      await config.deleteColumnMapping(
        params.boardId,
        params.teamId,
        params.sourceColumnId,
        call,
      );
      await invalidator.invalidateBoard(params.boardId, call);
      return reply.code(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Person overrides                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Display tidying for contractors and shared accounts — never
   * correctness, so a board reads fine with none of these. The hub has
   * always called these two routes; they simply were not here, and the
   * admin screen answered every load with "That route does not exist".
   */
  app.get(
    `${BOARDS_PATH}/:boardId/person-overrides`,
    async (request, reply) => {
      const auth = requireAuth(request);
      const call = auth.callOptions();
      const boardId = parseBoardIdParam(request.params);
      await loadBoardDefinition(config, boardId, call);
      return reply.send(await config.listPersonOverrides(boardId, call));
    },
  );

  app.put(
    `${BOARDS_PATH}/:boardId/person-overrides`,
    async (request, reply) => {
      const auth = requireAuth(request);
      const call = auth.callOptions();
      const boardId = parseBoardIdParam(request.params);
      const body = parseWith(
        personOverridesBodySchema,
        request.body,
        'person overrides',
      );
      await owned(boardId, await auth.acl(), call);
      const overrides: PersonOverride[] = body.map((override) => ({
        ...override,
        boardId,
      }));
      const saved = await config.replacePersonOverrides(
        boardId,
        overrides,
        call,
      );
      await invalidator.invalidateBoard(boardId, call);
      return reply.send(saved);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Unmapped columns                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * The count the mapping screen shows. Owner only, and it answers with
   * counts and column names — never with cards, which would bypass the
   * trimming every other read goes through.
   */
  app.get(`${BOARDS_PATH}/:boardId/unmapped`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const query = parseSnapshotQuery(request.query);
    const definition = await owned(boardId, await auth.acl(), call);
    const built = await options.boards.loadUntrimmed({
      definition,
      query,
      options: call,
      logger: requestLogger(request, options.logger),
    });
    return reply.send({
      boardId,
      unmappedColumns: built.snapshot.unmappedColumns,
      unmappedCardCount: unmappedCardCount(built.snapshot.cards),
      cardCount: built.snapshot.cards.length,
    });
  });
}
