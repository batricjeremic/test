/**
 * The two Fastify surfaces of the realtime module, exported as plugins
 * the composition root mounts: the board WebSocket and the
 * `workitem.updated` webhook.
 *
 * Both are deliberately thin. The socket handler authenticates, hands
 * the socket to the hub and wires the close, error and pong listeners
 * that keep the channel maps honest; the webhook handler builds the
 * trace id and delegates to `acceptWorkItemUpdated`. Everything worth
 * testing lives under it, in `hub.js`, `verify.js` and `webhook.js`.
 */
import type { Descriptor } from '@eg/shared';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { toAppError, UnauthorizedError } from '../errors.js';
import { newTraceId } from '../logging.js';
import type { CallerIdentity, Logger } from '../ports.js';
import type { BoardSubscription, WebSocketHub } from './hub.js';
import { REALTIME_CLOSE_CODES, type ManagedSocket } from './socket.js';
import {
  acceptWorkItemUpdated,
  WebhookWorkQueue,
  type WorkItemUpdatedDeps,
} from './webhook.js';
import type { WebhookAuth } from './verify.js';

/** Default mount points, so the hub and the subscription agree. */
export const REALTIME_SOCKET_PATH = '/api/boards/:boardId/stream';
export const WORK_ITEM_HOOK_PATH = '/api/hooks/workitem-updated';

/** How long the deferred hook fan-out may run before it is abandoned. */
export const DEFAULT_HOOK_WORK_TIMEOUT_MS = 15_000;

const traceHeader = (request: FastifyRequest): string => {
  const header = request.headers['x-trace-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && value.length > 0 ? value : newTraceId();
};

/* ------------------------------------------------------------------ */
/* Board socket                                                        */
/* ------------------------------------------------------------------ */

export interface AttachSocketInput {
  readonly hub: WebSocketHub;
  readonly socket: ManagedSocket;
  readonly boardId: string;
  readonly descriptor: Descriptor;
  readonly traceId: string;
  readonly logger: Logger;
}

/**
 * Registers an authenticated socket and wires its lifecycle. Returns
 * null when the hub refused it, in which case the socket has already
 * been closed with a reason. Cleanup runs from the socket's own close
 * event, so a peer that vanishes still frees its channel entry.
 */
export function attachSocket(
  input: AttachSocketInput,
): BoardSubscription | null {
  const log = input.logger.withTraceId(input.traceId);
  let subscription: BoardSubscription;
  try {
    subscription = input.hub.subscribe({
      boardId: input.boardId,
      descriptor: input.descriptor,
      socket: input.socket,
      traceId: input.traceId,
    });
  } catch (error) {
    const failure = toAppError(error);
    log.warn('board socket refused', {
      boardId: input.boardId,
      descriptor: input.descriptor,
      code: failure.code,
    });
    input.socket.close(REALTIME_CLOSE_CODES.tryAgainLater, failure.code);
    return null;
  }

  input.socket.on('close', () => {
    subscription.close();
  });
  input.socket.on('error', () => {
    subscription.close(REALTIME_CLOSE_CODES.goingAway, 'socket error');
  });
  input.socket.on('pong', () => {
    subscription.markAlive();
  });
  // Any frame from the peer is proof of life, whatever it carries.
  input.socket.on('message', () => {
    subscription.markAlive();
  });
  return subscription;
}

export type RealtimeAuthenticator = (
  request: FastifyRequest,
) => Promise<CallerIdentity>;

export interface RealtimeSocketPluginOptions {
  readonly hub: WebSocketHub;
  readonly logger: Logger;
  /** Validates the caller's token. Throws to refuse the upgrade. */
  readonly authenticate: RealtimeAuthenticator;
  readonly path?: string;
}

/**
 * `GET /api/boards/:boardId/stream`. Requires `@fastify/websocket` to be
 * registered by the composition root first.
 */
export async function realtimeSocketPlugin(
  fastify: FastifyInstance,
  options: RealtimeSocketPluginOptions,
): Promise<void> {
  const path = options.path ?? REALTIME_SOCKET_PATH;
  fastify.get(
    path,
    { websocket: true },
    async (rawSocket: WebSocket, request: FastifyRequest) => {
      const socket = rawSocket as unknown as ManagedSocket;
      const traceId = traceHeader(request);
      const params = request.params as { readonly boardId?: string };
      const boardId = params.boardId ?? '';
      let identity: CallerIdentity;
      try {
        if (boardId.length === 0) {
          throw new UnauthorizedError('A board id is required.');
        }
        identity = await options.authenticate(request);
      } catch (error) {
        const failure = toAppError(error);
        options.logger
          .withTraceId(traceId)
          .warn('board socket not authenticated', { code: failure.code });
        socket.close(REALTIME_CLOSE_CODES.policyViolation, failure.code);
        return;
      }

      attachSocket({
        hub: options.hub,
        socket,
        boardId,
        descriptor: identity.descriptor,
        traceId,
        logger: options.logger,
      });
    },
  );
}

/* ------------------------------------------------------------------ */
/* Service hook webhook                                                */
/* ------------------------------------------------------------------ */

export interface WorkItemHookPluginOptions {
  readonly auth: WebhookAuth;
  readonly deps: WorkItemUpdatedDeps;
  readonly path?: string;
  readonly queue?: WebhookWorkQueue;
  /** Bounds the deferred fan-out. Never leave it unbounded. */
  readonly workTimeoutMs?: number;
}

/**
 * `POST /api/hooks/workitem-updated`. Answers 202 as soon as the
 * delivery is authenticated and parsed; the invalidation and the delta
 * run on the queue, which the composition root drains on shutdown.
 */
export async function workItemHookPlugin(
  fastify: FastifyInstance,
  options: WorkItemHookPluginOptions,
): Promise<void> {
  const path = options.path ?? WORK_ITEM_HOOK_PATH;
  const queue = options.queue ?? new WebhookWorkQueue(options.deps.logger);
  const timeoutMs = options.workTimeoutMs ?? DEFAULT_HOOK_WORK_TIMEOUT_MS;

  fastify.post(path, async (request, reply) => {
    const traceId = traceHeader(request);
    try {
      const accepted = acceptWorkItemUpdated(
        { headers: request.headers, body: request.body },
        options.auth,
        options.deps,
        queue,
        { traceId, signal: AbortSignal.timeout(timeoutMs), timeoutMs },
      );
      return await reply.code(accepted.status).send(accepted.body);
    } catch (error) {
      const failure = toAppError(error);
      return await reply.code(failure.status).send(failure.toApiError(traceId));
    }
  });
}
