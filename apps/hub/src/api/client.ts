/**
 * The typed BFF client: one method per route.
 *
 * Every method sends the SDK token, an explicit timeout and a correlation
 * id, and parses the response with the Zod schema from `@eg/shared`.
 * `moveCard` is the exception to "throws on failure": it always resolves
 * to a `MoveResult`, because the write path must report a typed reason
 * rather than an exception the caller has to classify.
 */
import { z } from 'zod';
import {
  adoProjectRefSchema,
  adoTeamBoardRefSchema,
  adoTeamRefSchema,
  boardDefinitionSchema,
  boardSnapshotSchema,
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  moveRequestSchema,
  moveResultSchema,
  personOverrideSchema,
} from '@eg/shared';
import type {
  AdoProjectRef,
  AdoTeamBoardRef,
  AdoTeamRef,
  BoardDefinition,
  BoardSnapshot,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  MoveRequest,
  MoveResult,
  PersonOverride,
} from '@eg/shared';
import { requestJson } from './http';
import type { HttpConfig, RequestOptions } from './http';
import { encodeBoardQuery } from './query';
import type { BoardQuery } from './query';
import { toMoveFailure } from './moveFailures';
import type { MoveFailureContext } from './moveFailures';

/** A move carries the card context used to type a transport failure. */
export type MoveRequestOptions = RequestOptions & {
  context?: MoveFailureContext;
};

export type BoardApiClientConfig = HttpConfig & {
  /**
   * Timeout for a move. Shorter than a read: the spec's budget is one
   * second p95 and a user staring at a spinner needs an answer.
   * Default 10000.
   */
  moveTimeoutMs?: number;
};

export const DEFAULT_MOVE_TIMEOUT_MS = 10_000;

export interface BoardApiClient {
  /** `GET /api/boards/{boardId}/sprint` — one board load. */
  getBoardSnapshot(
    boardId: string,
    query: BoardQuery,
    options?: RequestOptions,
  ): Promise<BoardSnapshot>;

  /**
   * `POST /api/moves` — one drag. Never rejects: transport and HTTP
   * failures come back as `{ status: 'failed', failure }`.
   */
  moveCard(
    request: MoveRequest,
    options?: MoveRequestOptions,
  ): Promise<MoveResult>;

  /** `GET /api/boards` */
  listBoardDefinitions(options?: RequestOptions): Promise<BoardDefinition[]>;
  /** `GET /api/boards/{boardId}` */
  getBoardDefinition(
    boardId: string,
    options?: RequestOptions,
  ): Promise<BoardDefinition>;
  /** `POST /api/boards` */
  createBoardDefinition(
    definition: BoardDefinition,
    options?: RequestOptions,
  ): Promise<BoardDefinition>;
  /** `PUT /api/boards/{boardId}` */
  updateBoardDefinition(
    definition: BoardDefinition,
    options?: RequestOptions,
  ): Promise<BoardDefinition>;

  /** `GET /api/boards/{boardId}/sources` */
  listBoardSources(
    boardId: string,
    options?: RequestOptions,
  ): Promise<BoardSource[]>;
  /** `PUT /api/boards/{boardId}/sources` — the whole set, not a patch. */
  replaceBoardSources(
    boardId: string,
    sources: readonly BoardSource[],
    options?: RequestOptions,
  ): Promise<BoardSource[]>;

  /** `GET /api/boards/{boardId}/columns` */
  listCanonicalColumns(
    boardId: string,
    options?: RequestOptions,
  ): Promise<CanonicalColumn[]>;
  /** `PUT /api/boards/{boardId}/columns` — the whole ordered set. */
  replaceCanonicalColumns(
    boardId: string,
    columns: readonly CanonicalColumn[],
    options?: RequestOptions,
  ): Promise<CanonicalColumn[]>;

  /** `GET /api/boards/{boardId}/mappings` */
  listColumnMappings(
    boardId: string,
    options?: RequestOptions,
  ): Promise<ColumnMapping[]>;
  /** `PUT /api/boards/{boardId}/mappings` — the whole mapping table. */
  replaceColumnMappings(
    boardId: string,
    mappings: readonly ColumnMapping[],
    options?: RequestOptions,
  ): Promise<ColumnMapping[]>;

  /**
   * `GET /api/ado/projects` — the directory the source picker offers.
   * Read under the caller's own identity by the BFF, so it is the list
   * that person may see rather than the whole organisation.
   */
  listAdoProjects(options?: RequestOptions): Promise<AdoProjectRef[]>;
  /** `GET /api/ado/projects/{projectId}/teams` */
  listAdoTeams(
    projectId: string,
    options?: RequestOptions,
  ): Promise<AdoTeamRef[]>;
  /**
   * `GET /api/ado/projects/{projectId}/teams/{teamId}/boards` — the
   * values `BoardSource.backlogLevel` may take for that team.
   */
  listAdoTeamBoards(
    projectId: string,
    teamId: string,
    options?: RequestOptions,
  ): Promise<AdoTeamBoardRef[]>;

  /** `GET /api/boards/{boardId}/person-overrides` */
  listPersonOverrides(
    boardId: string,
    options?: RequestOptions,
  ): Promise<PersonOverride[]>;
  /** `PUT /api/boards/{boardId}/person-overrides` */
  replacePersonOverrides(
    boardId: string,
    overrides: readonly PersonOverride[],
    options?: RequestOptions,
  ): Promise<PersonOverride[]>;
}

const adoProjectRefListSchema = z.array(adoProjectRefSchema);
const adoTeamRefListSchema = z.array(adoTeamRefSchema);
const adoTeamBoardRefListSchema = z.array(adoTeamBoardRefSchema);
const boardDefinitionListSchema = z.array(boardDefinitionSchema);
const boardSourceListSchema = z.array(boardSourceSchema);
const canonicalColumnListSchema = z.array(canonicalColumnSchema);
const columnMappingListSchema = z.array(columnMappingSchema);
const personOverrideListSchema = z.array(personOverrideSchema);

export function createBoardApiClient(
  config: BoardApiClientConfig,
): BoardApiClient {
  const moveTimeoutMs = config.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;

  const boardPath = (boardId: string, suffix = ''): string =>
    `/api/boards/${encodeURIComponent(boardId)}${suffix}`;

  return {
    async getBoardSnapshot(boardId, query, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId, '/sprint'),
        query: encodeBoardQuery(query),
        schema: boardSnapshotSchema,
        options,
      });
      return response.data;
    },

    async moveCard(request, options = {}) {
      const { context, ...requestOptions } = options;
      const body = moveRequestSchema.parse(request);
      try {
        const response = await requestJson(config, {
          method: 'POST',
          path: '/api/moves',
          body,
          schema: moveResultSchema,
          options: { timeoutMs: moveTimeoutMs, ...requestOptions },
        });
        return response.data;
      } catch (error) {
        return {
          status: 'failed',
          workItemId: request.workItemId,
          failure: toMoveFailure(error, context ?? {}),
          card: context?.card ?? null,
        };
      }
    },

    async listBoardDefinitions(options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: '/api/boards',
        schema: boardDefinitionListSchema,
        options,
      });
      return response.data;
    },

    async getBoardDefinition(boardId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId),
        schema: boardDefinitionSchema,
        options,
      });
      return response.data;
    },

    async createBoardDefinition(definition, options) {
      const response = await requestJson(config, {
        method: 'POST',
        path: '/api/boards',
        body: boardDefinitionSchema.parse(definition),
        schema: boardDefinitionSchema,
        options,
      });
      return response.data;
    },

    async updateBoardDefinition(definition, options) {
      const response = await requestJson(config, {
        method: 'PUT',
        path: boardPath(definition.id),
        body: boardDefinitionSchema.parse(definition),
        schema: boardDefinitionSchema,
        options,
      });
      return response.data;
    },

    async listBoardSources(boardId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId, '/sources'),
        schema: boardSourceListSchema,
        options,
      });
      return response.data;
    },

    async replaceBoardSources(boardId, sources, options) {
      const response = await requestJson(config, {
        method: 'PUT',
        path: boardPath(boardId, '/sources'),
        body: boardSourceListSchema.parse(sources),
        schema: boardSourceListSchema,
        options,
      });
      return response.data;
    },

    async listCanonicalColumns(boardId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId, '/columns'),
        schema: canonicalColumnListSchema,
        options,
      });
      return response.data;
    },

    async replaceCanonicalColumns(boardId, columns, options) {
      const response = await requestJson(config, {
        method: 'PUT',
        path: boardPath(boardId, '/columns'),
        body: canonicalColumnListSchema.parse(columns),
        schema: canonicalColumnListSchema,
        options,
      });
      return response.data;
    },

    async listColumnMappings(boardId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId, '/mappings'),
        schema: columnMappingListSchema,
        options,
      });
      return response.data;
    },

    async replaceColumnMappings(boardId, mappings, options) {
      const response = await requestJson(config, {
        method: 'PUT',
        path: boardPath(boardId, '/mappings'),
        body: columnMappingListSchema.parse(mappings),
        schema: columnMappingListSchema,
        options,
      });
      return response.data;
    },

    async listAdoProjects(options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: '/api/ado/projects',
        schema: adoProjectRefListSchema,
        options,
      });
      return response.data;
    },

    async listAdoTeams(projectId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: `/api/ado/projects/${encodeURIComponent(projectId)}/teams`,
        schema: adoTeamRefListSchema,
        options,
      });
      return response.data;
    },

    async listAdoTeamBoards(projectId, teamId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path:
          `/api/ado/projects/${encodeURIComponent(projectId)}` +
          `/teams/${encodeURIComponent(teamId)}/boards`,
        schema: adoTeamBoardRefListSchema,
        options,
      });
      return response.data;
    },

    async listPersonOverrides(boardId, options) {
      const response = await requestJson(config, {
        method: 'GET',
        path: boardPath(boardId, '/person-overrides'),
        schema: personOverrideListSchema,
        options,
      });
      return response.data;
    },

    async replacePersonOverrides(boardId, overrides, options) {
      const response = await requestJson(config, {
        method: 'PUT',
        path: boardPath(boardId, '/person-overrides'),
        body: personOverrideListSchema.parse(overrides),
        schema: personOverrideListSchema,
        options,
      });
      return response.data;
    },
  };
}

/**
 * BFF origin. Set `VITE_BFF_BASE_URL` at build time; the hub and the BFF
 * are on different origins, so this is never a relative path in a real
 * deployment.
 */
export function resolveBffBaseUrl(): string {
  const configured = import.meta.env.VITE_BFF_BASE_URL;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim().replace(/\/+$/, '');
  }
  return 'http://localhost:8080';
}
