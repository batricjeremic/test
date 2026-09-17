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
  nonEmptyStringSchema,
  stateCategorySchema,
} from '@eg/shared';
import type {
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
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

export const boardSourcesBodySchema = z.object({
  sources: z.array(
    z.object({
      projectId: nonEmptyStringSchema,
      teamId: nonEmptyStringSchema,
      backlogLevel: nonEmptyStringSchema,
    }),
  ),
});

export const canonicalColumnsBodySchema = z.object({
  columns: z.array(
    z.object({
      id: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
      order: z.number().int().nonnegative(),
      stateCategory: stateCategorySchema,
    }),
  ),
});

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
    return reply.send({ boards: definitions });
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
    return reply.send({
      sources: await config.listBoardSources(boardId, call),
    });
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
    const sources: BoardSource[] = body.sources.map((source) => ({
      boardId,
      ...source,
    }));
    const saved = await config.replaceBoardSources(boardId, sources, call);
    // Team boards and their columns are re-read for the new source set.
    await invalidator.flushBoardColumns(
      boardId,
      scopesOf(options.orgId, [...previous, ...saved]),
      call,
    );
    await invalidator.invalidateBoard(boardId, call);
    return reply.send({ sources: saved });
  });

  /* ---------------------------------------------------------------- */
  /* Canonical columns                                                 */
  /* ---------------------------------------------------------------- */

  app.get(`${BOARDS_PATH}/:boardId/columns`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await loadBoardDefinition(config, boardId, call);
    return reply.send({
      columns: await config.listCanonicalColumns(boardId, call),
    });
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
    const columns: CanonicalColumn[] = body.columns.map((column) => ({
      boardId,
      ...column,
    }));
    const saved = await config.replaceCanonicalColumns(boardId, columns, call);
    await invalidator.invalidateBoard(boardId, call);
    return reply.send({ columns: saved });
  });

  /* ---------------------------------------------------------------- */
  /* Column mapping                                                    */
  /* ---------------------------------------------------------------- */

  app.get(`${BOARDS_PATH}/:boardId/mappings`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    await loadBoardDefinition(config, boardId, call);
    return reply.send({
      mappings: await config.listColumnMappings(boardId, call),
    });
  });

  app.put(`${BOARDS_PATH}/:boardId/mappings`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = auth.callOptions();
    const boardId = parseBoardIdParam(request.params);
    const body = parseWith(
      columnMappingBodySchema,
      request.body,
      'column mapping',
    );
    await owned(boardId, await auth.acl(), call);
    const mapping: ColumnMapping = { boardId, ...body };
    const saved = await config.upsertColumnMapping(mapping, call);
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
