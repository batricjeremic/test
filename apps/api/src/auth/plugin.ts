/**
 * The Fastify seam: one hook that turns a bearer token into an
 * authenticated identity, a trace id and a lazily resolved ACL.
 *
 * Spec, "Token flow": the hub "calls `SDK.getAccessToken()` and sends
 * that token on every request", the BFF "validates it against the Azure
 * DevOps issuer and extracts the caller's identity descriptor", and then
 * trims what it serves to that caller.
 *
 * Two deliberate choices:
 *
 * - the hook answers a rejected token itself rather than throwing into
 *   whatever error handler the app happens to have installed, so a 401
 *   is a 401 with an `ApiError` body no matter what else is registered;
 * - the ACL is resolved lazily but memoised per request, because a route
 *   that does not read board data should not pay for a fan-out, while
 *   one that reads twice should not resolve twice.
 *
 * The caller's token lives on `request.egAuth.identity` for the life of
 * the request and is never logged, cached or persisted.
 */
import { TRACE_ID_HEADER } from '@eg/shared';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { toAppError, UnauthorizedError } from '../errors.js';
import { newTraceId } from '../logging.js';
import type {
  AclResolver,
  CallOptions,
  CallerAcl,
  CallerIdentity,
  Logger,
} from '../ports.js';
import type { TokenVerifier } from './token.js';
import {
  extractBearerToken,
  identityLogFields,
  isTokenRejected,
  toCallerIdentity,
} from './token.js';

/** Headers a caller may use to join our trace to theirs. */
export const TRACE_ID_HEADERS: readonly string[] = [
  'x-trace-id',
  'x-request-id',
];
/** Echoed on every response, so a support ticket can carry the id. */
export const TRACE_ID_RESPONSE_HEADER: string = TRACE_ID_HEADER;

/** A trace id a caller supplied has to look like one before we adopt it. */
const SAFE_TRACE_ID = /^[A-Za-z0-9._-]{8,128}$/u;

export function traceIdFromHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string {
  for (const name of TRACE_ID_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined && SAFE_TRACE_ID.test(value)) return value;
  }
  return newTraceId();
}

/** What the hook attaches. Everything a handler needs about the caller. */
export interface AuthContext {
  readonly traceId: string;
  readonly logger: Logger;
  readonly identity: CallerIdentity;
  /** Scopes the token carried, e.g. `vso.work_write`. */
  readonly scopes: readonly string[];
  /** Call options for this request, with the trace id already set. */
  callOptions(): CallOptions;
  /**
   * The caller's ACL, resolved once per request. It rejects when the
   * ACL cannot be resolved — the request then fails and serves nothing,
   * which is the fail-closed half of security trimming.
   */
  acl(): Promise<CallerAcl>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `registerAuth`; absent on exempt routes. */
    egAuth?: AuthContext | null;
  }
}

export interface AuthHookOptions {
  readonly verifier: TokenVerifier;
  readonly acl: AclResolver;
  readonly logger: Logger;
  /** Explicit timeout for the ACL probe, per the outbound-call rule. */
  readonly aclTimeoutMs?: number;
  /**
   * Routes that authenticate some other way — the health probe, and the
   * service-hook webhook, which is verified by signature in
   * `realtime/verify.ts` rather than by a user token.
   */
  readonly isExempt?: (request: FastifyRequest) => boolean;
}

class RequestAuthContext implements AuthContext {
  readonly traceId: string;
  readonly logger: Logger;
  readonly identity: CallerIdentity;
  readonly scopes: readonly string[];
  private readonly resolver: AclResolver;
  private readonly timeoutMs: number | undefined;
  private readonly signal: AbortSignal;
  private pending: Promise<CallerAcl> | null = null;

  constructor(input: {
    traceId: string;
    logger: Logger;
    identity: CallerIdentity;
    scopes: readonly string[];
    resolver: AclResolver;
    timeoutMs: number | undefined;
    signal: AbortSignal;
  }) {
    this.traceId = input.traceId;
    this.logger = input.logger;
    this.identity = input.identity;
    this.scopes = input.scopes;
    this.resolver = input.resolver;
    this.timeoutMs = input.timeoutMs;
    this.signal = input.signal;
  }

  callOptions(): CallOptions {
    return {
      traceId: this.traceId,
      signal: this.signal,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    };
  }

  acl(): Promise<CallerAcl> {
    this.pending ??= this.resolver.resolve(this.identity, this.callOptions());
    return this.pending;
  }
}

/**
 * The hook itself, exported separately so a route can be tested with it
 * without standing up the whole app.
 */
export function createAuthPreHandler(
  options: AuthHookOptions,
): preHandlerAsyncHookHandler {
  return async function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> {
    const traceId = traceIdFromHeaders(request.headers);
    void reply.header(TRACE_ID_RESPONSE_HEADER, traceId);
    const logger = options.logger.withTraceId(traceId);

    if (options.isExempt?.(request) === true) {
      request.egAuth = null;
      return;
    }

    // Node's IncomingMessage carries no AbortSignal, so the request gets
    // one that fires when the connection closes: every port call this
    // request makes is then cancellable, per the outbound-call rule.
    const aborter = new AbortController();
    reply.raw.on('close', () => {
      aborter.abort();
    });

    const token = extractBearerToken(request.headers.authorization);
    try {
      if (token === null) {
        throw new UnauthorizedError(
          'Authorization header missing or not a bearer token',
        );
      }
      const verified = await options.verifier.verify(token, {
        traceId,
        signal: aborter.signal,
      });
      request.egAuth = new RequestAuthContext({
        traceId,
        logger: logger.child({ descriptor: verified.descriptor }),
        identity: toCallerIdentity(verified, token),
        scopes: verified.scopes,
        resolver: options.acl,
        timeoutMs: options.aclTimeoutMs,
        signal: aborter.signal,
      });
      logger.debug('request authenticated', {
        ...identityLogFields(verified),
        method: request.method,
        route: request.routeOptions.url ?? request.url,
      });
      return;
    } catch (error) {
      request.egAuth = null;
      const failure = toAppError(error);
      logger.warn('request rejected', {
        code: failure.code,
        status: failure.status,
        reason: isTokenRejected(error) ? error.rejection : failure.message,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
      });
      return await reply.code(failure.status).send(failure.toApiError(traceId));
    }
  };
}

/**
 * Decorates the request and installs the hook. Call once, before the
 * routes: Fastify requires decorators to exist before a request does.
 */
export function registerAuth(
  app: FastifyInstance,
  options: AuthHookOptions,
): void {
  if (!app.hasRequestDecorator('egAuth')) {
    app.decorateRequest('egAuth', null);
  }
  app.addHook('preHandler', createAuthPreHandler(options));
}

/**
 * The authenticated caller, or a 401. A handler that needs an identity
 * calls this rather than reading the decorator, so "the hook did not
 * run" and "the caller is anonymous" fail the same, closed way.
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  const context = request.egAuth;
  if (context === undefined || context === null) {
    throw new UnauthorizedError('Request is not authenticated');
  }
  return context;
}

/** The caller's ACL, resolved once per request. Throws if it cannot be. */
export async function requireAcl(request: FastifyRequest): Promise<CallerAcl> {
  return await requireAuth(request).acl();
}
