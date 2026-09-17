/**
 * The board read route.
 *
 * Spec: "Hub asks the SDK for the user token ... calls
 * `GET /api/boards/{boardId}/sprint?window=current`."
 *
 * The handler is deliberately four lines of work: authenticate (the auth
 * hook has already done it), validate the id and the query, resolve the
 * board, load it and trim it. `boardSnapshotBody` only accepts a trimmed
 * snapshot, so a refactor that forgets the ACL does not compile.
 */
import type { FastifyInstance } from 'fastify';
import { boardSnapshotBody } from '../auth/trim.js';
import { requireAuth } from '../auth/plugin.js';
import type { ConfigStore, Logger } from '../ports.js';
import type { BoardReadService } from './board-service.js';
import { loadBoardDefinition } from './board-context.js';
import { requestLogger } from './context.js';
import { parseBoardIdParam, parseSnapshotQuery } from './query.js';

export const BOARD_SPRINT_PATH = '/api/boards/:boardId/sprint';

export interface BoardRouteOptions {
  readonly boards: BoardReadService;
  readonly config: ConfigStore;
  readonly logger: Logger;
}

export async function boardRoutes(
  app: FastifyInstance,
  options: BoardRouteOptions,
): Promise<void> {
  app.get(BOARD_SPRINT_PATH, async (request, reply) => {
    const auth = requireAuth(request);
    const boardId = parseBoardIdParam(request.params);
    const query = parseSnapshotQuery(request.query);
    const logger = requestLogger(request, options.logger);
    const call = auth.callOptions();

    const definition = await loadBoardDefinition(options.config, boardId, call);
    // Fail closed: an ACL that cannot be resolved serves nothing.
    const acl = await auth.acl();
    const snapshot = await options.boards.load(
      { definition, query, options: call, logger },
      acl,
    );
    return reply.send(boardSnapshotBody(snapshot));
  });
}
