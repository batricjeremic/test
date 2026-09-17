/**
 * `POST /api/moves`.
 *
 * The body is parsed with the shared `moveRequestSchema`, so a client
 * cannot invent a field; everything else — the owning team, the board,
 * the mapping, the permission — is resolved server side. The client's
 * `rev` is the one thing taken on trust, and only because trusting it is
 * the point: it goes on the wire as the JSON Patch `test` operation.
 */
import { moveRequestSchema } from '@eg/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import type { Logger } from '../ports.js';
import { parseWith, requestLogger } from './context.js';
import type { MoveService } from './move-service.js';

export const MOVES_PATH = '/api/moves';

export interface MoveRouteOptions {
  readonly moves: MoveService;
  readonly logger: Logger;
}

export async function moveRoutes(
  app: FastifyInstance,
  options: MoveRouteOptions,
): Promise<void> {
  app.post(MOVES_PATH, async (request, reply) => {
    const auth = requireAuth(request);
    const move = parseWith(moveRequestSchema, request.body, 'move request');
    const acl = await auth.acl();
    const outcome = await options.moves.apply({
      request: move,
      identity: auth.identity,
      acl,
      options: auth.callOptions(),
      logger: requestLogger(request, options.logger),
    });
    return reply.code(outcome.status).send(outcome.result);
  });
}
