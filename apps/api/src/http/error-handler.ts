/**
 * The one place a thrown value becomes an HTTP response.
 *
 * Two rules, both from the ExpertGroup standards and the spec's security
 * section. The body is always an `ApiError`: a stable machine-readable
 * `code`, a message written for a user, the status and the trace id. And
 * the internal message never leaves the process — `AppError.message` may
 * repeat what Azure DevOps said and may name internals, so only
 * `userMessage` is serialised, which is what `toApiError` does.
 *
 * `details` is dropped on 5xx as well: at that point we do not know
 * enough about what went wrong to promise it is safe to show.
 */
import type { ApiError } from '@eg/shared';
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { AppError, AppErrorCode } from '../errors.js';
import {
  AppError as AppErrorClass,
  isAppError,
  toAppError,
} from '../errors.js';
import type { Logger } from '../ports.js';
import { requestLogger, requestTraceId } from './context.js';

const codeForStatus = (status: number): AppErrorCode => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'validation_failed';
};

const userMessageForStatus = (status: number): string => {
  if (status === 401) return 'Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That route does not exist.';
  if (status === 413) return 'That request was too large.';
  if (status === 415) return 'That content type is not supported.';
  if (status >= 500) return 'Something went wrong.';
  return 'That request was not valid.';
};

/**
 * Anything thrown, as an `AppError`. Fastify's own errors — a body over
 * the limit, an unparseable JSON payload — carry a status we keep, but
 * not a message we forward.
 */
export function httpErrorFor(error: unknown): AppError {
  if (isAppError(error)) return error;
  const status = (error as FastifyError | undefined)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    const message = error instanceof Error ? error.message : 'Request failed';
    return new AppErrorClass(
      codeForStatus(status),
      status,
      message,
      userMessageForStatus(status),
      { cause: error },
    );
  }
  return toAppError(error);
}

/** The response body, with `details` withheld on server errors. */
export function toSafeApiError(error: AppError, traceId: string): ApiError {
  const body = error.toApiError(traceId);
  if (error.status < 500) return body;
  const { details: _details, ...rest } = body;
  return rest;
}

export function createErrorHandler(
  logger: Logger,
): (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply> {
  return async function handleError(error, request, reply) {
    const traceId = requestTraceId(request);
    const failure = httpErrorFor(error);
    const fields = {
      code: failure.code,
      status: failure.status,
      method: request.method,
      route: request.routeOptions.url ?? request.url,
    };
    const log = requestLogger(request, logger);
    if (failure.status < 500) {
      log.warn('request rejected', fields);
      return reply.code(failure.status).send(toSafeApiError(failure, traceId));
    }
    // Our own errors carry a message we wrote; anything else came from a
    // driver or a library and may have a connection string in it, so only
    // its type is logged. The trace id ties this line to the module that
    // raised it, which logs its own redacted detail.
    log.error('request failed', {
      ...fields,
      ...(isAppError(error)
        ? { message: failure.message }
        : { errorType: failure.name }),
    });
    return reply.code(failure.status).send(toSafeApiError(failure, traceId));
  };
}

/** An unknown route answers in the same shape as everything else. */
export function createNotFoundHandler(
  logger: Logger,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async function handleNotFound(request, reply) {
    const traceId = requestTraceId(request);
    requestLogger(request, logger).warn('route not found', {
      method: request.method,
      route: request.url,
    });
    return reply
      .code(404)
      .send(
        new AppErrorClass(
          'not_found',
          404,
          `No route for ${request.method} ${request.url}`,
          userMessageForStatus(404),
        ).toApiError(traceId),
      );
  };
}

/** Installs both handlers on an instance. */
export function registerErrorHandling(
  app: FastifyInstance,
  logger: Logger,
): void {
  app.setErrorHandler(createErrorHandler(logger));
  app.setNotFoundHandler(createNotFoundHandler(logger));
}
