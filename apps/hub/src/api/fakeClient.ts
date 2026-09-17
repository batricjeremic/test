/**
 * An in-memory `BoardApiClient`.
 *
 * Tests inject this instead of running a real BFF; the component tests
 * the board and admin views write can drive it the same way. It records
 * what was sent and lets a test queue the next move's outcome, including
 * leaving a move in flight so the card's locked state can be asserted.
 */
import type {
  BoardCard,
  BoardDefinition,
  BoardSnapshot,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  MoveFailure,
  MoveRequest,
  MoveResult,
  PersonOverride,
} from '@eg/shared';
import type { BoardApiClient, MoveRequestOptions } from './client';
import type { RequestOptions } from './http';
import type { BoardQuery } from './query';
import { makeBoardSnapshot } from './fixtures';
import { toMoveFailure } from './moveFailures';

export type MoveHandler = (
  request: MoveRequest,
) => MoveResult | Promise<MoveResult>;

/** A move the test holds open, so the card stays locked and spinning. */
export type DeferredMove = {
  /** Resolves as soon as the hub has actually sent the move. */
  readonly sent: Promise<MoveRequest>;
  resolve(result: MoveResult): void;
  reject(error: unknown): void;
};

export type FakeBoardApiClientOptions = {
  snapshot?: BoardSnapshot;
  definitions?: BoardDefinition[];
  sources?: BoardSource[];
  columns?: CanonicalColumn[];
  mappings?: ColumnMapping[];
  personOverrides?: PersonOverride[];
};

export interface FakeBoardApiClient extends BoardApiClient {
  readonly moveRequests: readonly MoveRequest[];
  readonly snapshotRequests: readonly {
    boardId: string;
    query: BoardQuery;
  }[];
  /** The snapshot the next `getBoardSnapshot` returns. */
  getSnapshot(): BoardSnapshot;
  setSnapshot(snapshot: BoardSnapshot): void;
  /** Makes the next snapshot read reject with this error. */
  failNextSnapshot(error: unknown): void;
  /** Queues the handler for the next move. Handlers are used in order. */
  queueMove(handler: MoveHandler): void;
  /** Queues a typed failure for the next move. */
  failNextMove(failure: MoveFailure, card?: BoardCard | null): void;
  /**
   * Queues a transport-level throw for the next move, mapped through the
   * same `toMoveFailure` path the real client uses.
   */
  throwOnNextMove(error: unknown): void;
  /** Holds the next move open until the test resolves it. */
  deferNextMove(): DeferredMove;
}

export function createFakeBoardApiClient(
  options: FakeBoardApiClientOptions = {},
): FakeBoardApiClient {
  let snapshot = options.snapshot ?? makeBoardSnapshot();
  let definitions = [...(options.definitions ?? [])];
  let sources = [...(options.sources ?? [])];
  let columns = [...(options.columns ?? snapshot.columns)];
  let mappings = [...(options.mappings ?? [])];
  let personOverrides = [...(options.personOverrides ?? [])];

  const moveRequests: MoveRequest[] = [];
  const snapshotRequests: { boardId: string; query: BoardQuery }[] = [];
  const moveHandlers: MoveHandler[] = [];
  let nextSnapshotError: unknown = null;

  const applyLocally = (request: MoveRequest): MoveResult => {
    const card = snapshot.cards.find(
      (candidate) => candidate.workItemId === request.workItemId,
    );
    if (!card) {
      return {
        status: 'failed',
        workItemId: request.workItemId,
        failure: {
          reason: 'service-unavailable',
          message: 'The fake client has no such card.',
          attempts: 1,
          retryAfterSeconds: null,
        },
        card: null,
      };
    }
    const moved: BoardCard = {
      ...card,
      canonicalColumnId: request.toCanonicalColumnId,
      rev: card.rev + 1,
    };
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.map((candidate) =>
        candidate.workItemId === moved.workItemId ? moved : candidate,
      ),
    };
    return {
      status: 'applied',
      workItemId: moved.workItemId,
      card: moved,
      stateChanged: false,
    };
  };

  return {
    async getBoardSnapshot(boardId, query, _options?: RequestOptions) {
      snapshotRequests.push({ boardId, query });
      if (nextSnapshotError !== null) {
        const error = nextSnapshotError;
        nextSnapshotError = null;
        throw error;
      }
      return snapshot;
    },

    async moveCard(request: MoveRequest, options: MoveRequestOptions = {}) {
      moveRequests.push(request);
      const handler = moveHandlers.shift();
      try {
        return handler ? await handler(request) : applyLocally(request);
      } catch (error) {
        return {
          status: 'failed',
          workItemId: request.workItemId,
          failure: toMoveFailure(error, options.context ?? {}),
          card: options.context?.card ?? null,
        };
      }
    },

    async listBoardDefinitions() {
      return definitions;
    },
    async getBoardDefinition(boardId) {
      const found = definitions.find((entry) => entry.id === boardId);
      if (!found) throw new Error(`No board definition ${boardId}`);
      return found;
    },
    async createBoardDefinition(definition) {
      definitions = [...definitions, definition];
      return definition;
    },
    async updateBoardDefinition(definition) {
      definitions = definitions.map((entry) =>
        entry.id === definition.id ? definition : entry,
      );
      return definition;
    },

    async listBoardSources() {
      return sources;
    },
    async replaceBoardSources(_boardId, next) {
      sources = [...next];
      return sources;
    },

    async listCanonicalColumns() {
      return columns;
    },
    async replaceCanonicalColumns(_boardId, next) {
      columns = [...next];
      return columns;
    },

    async listColumnMappings() {
      return mappings;
    },
    async replaceColumnMappings(_boardId, next) {
      mappings = [...next];
      return mappings;
    },

    async listPersonOverrides() {
      return personOverrides;
    },
    async replacePersonOverrides(_boardId, next) {
      personOverrides = [...next];
      return personOverrides;
    },

    get moveRequests() {
      return moveRequests;
    },
    get snapshotRequests() {
      return snapshotRequests;
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
    },
    failNextSnapshot: (error) => {
      nextSnapshotError = error;
    },
    queueMove: (handler) => {
      moveHandlers.push(handler);
    },
    failNextMove: (failure, card = null) => {
      moveHandlers.push((request) => ({
        status: 'failed',
        workItemId: request.workItemId,
        failure,
        card,
      }));
    },
    throwOnNextMove: (error) => {
      moveHandlers.push(() => {
        throw error;
      });
    },
    deferNextMove: () => {
      let resolveResult: (result: MoveResult) => void = () => undefined;
      let rejectResult: (error: unknown) => void = () => undefined;
      let markSent: (request: MoveRequest) => void = () => undefined;

      const result = new Promise<MoveResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const sent = new Promise<MoveRequest>((resolve) => {
        markSent = resolve;
      });

      moveHandlers.push((request) => {
        markSent(request);
        return result;
      });

      return {
        sent,
        resolve: (value) => resolveResult(value),
        reject: (error) => rejectResult(error),
      };
    },
  };
}
