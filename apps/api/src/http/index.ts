/**
 * The HTTP surface, assembled: the services the routes need, built from
 * the container's ports, and the registration that mounts every route.
 *
 * Nothing here knows about Redis, Postgres or undici — only about the
 * ports — so the whole surface can be driven with `fastify.inject()`
 * against fakes.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../container.js';
import type { WebhookCardLookup } from '../realtime/index.js';
import { adminRoutes } from './admin.js';
import { BoardReadService } from './board-service.js';
import type { BoardReadDeps } from './board-service.js';
import { boardRoutes } from './boards.js';
import { healthRoutes } from './health.js';
import { MoveService } from './move-service.js';
import { moveRoutes } from './moves.js';
import { createWebhookCardLookup } from './webhook-cards.js';

export interface HttpServices {
  readonly boards: BoardReadService;
  readonly moves: MoveService;
  readonly cards: WebhookCardLookup;
}

/** The ports every read and write service is built on. */
function readDeps(container: AppContainer): BoardReadDeps {
  const ports = container.ports;
  return {
    ado: ports.ado,
    cache: ports.cache,
    config: ports.config,
    logger: ports.logger,
    clock: ports.clock,
    orgId: container.orgId,
    callTimeoutMs: container.config.ado.requestTimeoutMs,
    invalidator: container.invalidator,
    realtime: ports.realtime,
    hooks: container.hooks,
  };
}

export function createHttpServices(container: AppContainer): HttpServices {
  const deps = readDeps(container);
  return {
    boards: new BoardReadService(deps),
    moves: new MoveService({
      ...deps,
      deltas: container.deltas,
      adoOrgUrl: container.config.ado.orgUrl,
    }),
    cards: createWebhookCardLookup(deps),
  };
}

/** Mounts health, the board read, the write path and the admin surface. */
export async function registerRoutes(
  app: FastifyInstance,
  container: AppContainer,
  services: HttpServices = createHttpServices(container),
): Promise<void> {
  const ports = container.ports;

  await app.register(healthRoutes, {
    config: ports.config,
    cache: ports.cache,
    clock: ports.clock,
    logger: ports.logger,
    orgId: container.orgId,
    probeTimeoutMs: container.config.postgres.requestTimeoutMs,
  });

  await app.register(boardRoutes, {
    boards: services.boards,
    config: ports.config,
    logger: ports.logger,
  });

  await app.register(moveRoutes, {
    moves: services.moves,
    logger: ports.logger,
  });

  await app.register(adminRoutes, {
    config: ports.config,
    invalidator: container.invalidator,
    boards: services.boards,
    orgId: container.orgId,
    logger: ports.logger,
  });
}

export { BoardReadService } from './board-service.js';
export { MoveService } from './move-service.js';
export { BOARD_SPRINT_PATH } from './boards.js';
export { MOVES_PATH } from './moves.js';
export { BOARDS_PATH } from './admin.js';
export { HEALTH_PATH, READY_PATH } from './health.js';
