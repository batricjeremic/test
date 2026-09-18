/**
 * The Fastify instance.
 *
 * Spec, "Architecture": the hub talks to this over HTTPS with a JWT and
 * over a WebSocket for deltas, and Azure DevOps service hooks post to the
 * webhook. So the app is: security headers, CORS scoped to Azure DevOps,
 * one correlation id per request, the auth hook, a JSON error handler
 * that never leaks an internal message or a token, a bounded body, and
 * the routes plus the two realtime plugins.
 *
 * What it deliberately does not do is run migrations. Those are applied
 * by the pipeline, never at startup and never from a dev session.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  extractBearerToken,
  registerAuth,
  toCallerIdentity,
  TRACE_ID_RESPONSE_HEADER,
  traceIdFromHeaders,
} from './auth/index.js';
import type { AppContainer } from './container.js';
import { UnauthorizedError } from './errors.js';
import { registerErrorHandling } from './http/error-handler.js';
import { HEALTH_PATH, READY_PATH } from './http/health.js';
import { createHttpServices, registerRoutes } from './http/index.js';
import type { HttpServices } from './http/index.js';
import { TRACE_HEADER } from './http/context.js';
import type { CallerIdentity, Logger } from './ports.js';
import {
  realtimeSocketPlugin,
  REALTIME_SOCKET_PATH,
  workItemHookPlugin,
  WORK_ITEM_HOOK_PATH,
} from './realtime/index.js';

/** A move request is a few hundred bytes; nothing here needs a megabyte. */
export const DEFAULT_BODY_LIMIT_BYTES = 262_144;

/** Largest realtime frame accepted from a peer. */
const MAX_SOCKET_PAYLOAD_BYTES = 65_536;

/**
 * Routes that authenticate some other way, or not at all. An unknown
 * route is not on the list, so an anonymous caller is told 401 rather
 * than which routes exist; an authenticated one gets a plain 404.
 */
export const UNAUTHENTICATED_ROUTES: readonly string[] = [
  HEALTH_PATH,
  READY_PATH,
  // Verified by shared secret in `realtime/verify.ts`.
  WORK_ITEM_HOOK_PATH,
  // Verified on the upgrade, before the socket joins a channel.
  REALTIME_SOCKET_PATH,
];

export interface AppOptions {
  readonly container: AppContainer;
  readonly services?: HttpServices;
  readonly bodyLimit?: number;
  readonly trustProxy?: boolean;
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

const ADO_ORIGIN_SUFFIXES: readonly string[] = [
  '.visualstudio.com',
  '.dev.azure.com',
  '.vsassets.io',
  '.gallerycdn.vsassets.io',
];

/**
 * The hub runs inside Azure DevOps, so that is the only browser origin
 * that may call the BFF: the organisation's own origin, `dev.azure.com`
 * and the extension iframe hosts. Everything else is refused, and a
 * request with no `Origin` at all — server to server, or the service
 * hook — is not a cross-origin request and is left alone.
 */
export function isAzureDevOpsOrigin(
  origin: string | undefined,
  orgUrl: string,
): boolean {
  if (origin === undefined || origin.length === 0) return true;
  let candidate: URL;
  let organisation: URL;
  try {
    candidate = new URL(origin);
    organisation = new URL(orgUrl);
  } catch {
    return false;
  }
  if (candidate.protocol !== 'https:') return false;
  if (candidate.host === organisation.host) return true;
  if (candidate.hostname === 'dev.azure.com') return true;
  return ADO_ORIGIN_SUFFIXES.some((suffix) =>
    candidate.hostname.endsWith(suffix),
  );
}

/* ------------------------------------------------------------------ */
/* WebSocket authentication                                            */
/* ------------------------------------------------------------------ */

/**
 * A browser cannot set an `Authorization` header on a WebSocket, so the
 * token may also arrive as the second subprotocol — never in the query
 * string, which would put it in every access log we do not control.
 */
export function socketToken(request: FastifyRequest): string | null {
  const header = extractBearerToken(request.headers.authorization);
  if (header !== null) return header;
  const raw = request.headers['sec-websocket-protocol'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (value === undefined) return null;
  const parts = value.split(',').map((part) => part.trim());
  const [scheme, token] = parts;
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined) return null;
  return token.length > 0 ? token : null;
}

const socketAuthenticator =
  (container: AppContainer) =>
  async (request: FastifyRequest): Promise<CallerIdentity> => {
    const token = socketToken(request);
    if (token === null) {
      throw new UnauthorizedError('Board socket carried no bearer token');
    }
    const verified = await container.verifier.verify(token, {
      traceId: traceIdFromHeaders(request.headers),
    });
    return toCallerIdentity(verified, token);
  };

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

/** Builds the instance. It listens only when `server.ts` says so. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const container = options.container;
  const logger: Logger = container.ports.logger;
  const services = options.services ?? createHttpServices(container);

  const app = Fastify({
    // Logging is the injected `Logger`'s job: one structured line per
    // request, carrying the trace id, with redaction already applied.
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('egTraceId', null);
  app.decorateRequest('egLogger', null);

  /**
   * One correlation id per request, adopted from the caller when they
   * sent one. It is written back onto the request headers so every hook
   * and plugin downstream — the auth hook, the realtime plugins — derives
   * the same id rather than minting a second one.
   */
  app.addHook('onRequest', async (request, reply) => {
    const traceId = traceIdFromHeaders(request.headers);
    request.headers[TRACE_HEADER] = traceId;
    request.egTraceId = traceId;
    request.egLogger = logger.withTraceId(traceId).child({
      method: request.method,
      route: request.routeOptions.url ?? request.url,
    });
    void reply.header(TRACE_ID_RESPONSE_HEADER, traceId);
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAzureDevOpsOrigin(origin, container.config.ado.orgUrl));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', TRACE_HEADER],
    exposedHeaders: [TRACE_ID_RESPONSE_HEADER],
    maxAge: 600,
  });

  registerErrorHandling(app, logger);

  registerAuth(app, {
    verifier: container.verifier,
    acl: container.ports.acl,
    logger,
    aclTimeoutMs: container.config.ado.requestTimeoutMs,
    isExempt: (request) =>
      UNAUTHENTICATED_ROUTES.includes(request.routeOptions.url ?? request.url),
  });

  await registerRoutes(app, container, services);

  if (container.hub !== null) {
    await app.register(websocket, {
      options: { maxPayload: MAX_SOCKET_PAYLOAD_BYTES },
    });
    await app.register(realtimeSocketPlugin, {
      hub: container.hub,
      logger,
      authenticate: socketAuthenticator(container),
    });
  }

  if (container.webhookAuth !== null) {
    await app.register(workItemHookPlugin, {
      auth: container.webhookAuth,
      queue: container.webhookQueue,
      deps: {
        logger,
        invalidator: container.invalidator,
        publisher: container.deltas,
        cards: services.cards,
        hooks: container.hooks,
      },
    });
  } else {
    logger.warn('service hook webhook is not mounted', {
      reason: 'no webhook credentials configured',
    });
  }

  await app.ready();
  return app;
}
