/**
 * Request-scoped plumbing shared by every route: the correlation id, the
 * logger bound to it, and Zod parsing at the HTTP boundary.
 *
 * Spec, ExpertGroup standards: "structured logging with trace id" and
 * "validate everything crossing a process boundary with Zod". A handler
 * therefore never reads `request.query` or `request.body` directly; it
 * asks for a parsed value and gets a `ValidationError` if the caller sent
 * something else.
 */
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { ValidationError } from '../errors.js';
import type { Logger } from '../ports.js';

/** Header the correlation id is adopted from and echoed on. */
export const TRACE_HEADER = 'x-trace-id';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the app's `onRequest` hook, before anything else runs. */
    egTraceId?: string;
    egLogger?: Logger;
  }
}

/** The id this request is traced by. Always set by the app's hook. */
export function requestTraceId(request: FastifyRequest): string {
  const value = request.egTraceId;
  if (value !== undefined && value.length > 0) return value;
  const header = request.headers[TRACE_HEADER];
  const first = Array.isArray(header) ? header[0] : header;
  return first ?? 'untraced';
}

/** The request logger, or a child of `fallback` carrying the trace id. */
export function requestLogger(
  request: FastifyRequest,
  fallback: Logger,
): Logger {
  return request.egLogger ?? fallback.withTraceId(requestTraceId(request));
}

/** Zod issues reduced to something safe to hand back to a caller. */
export function issueDetails(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Parses one value at the process boundary. The thrown error carries the
 * field paths that failed, never the value that failed them: a body may
 * hold a token, a path never does.
 */
export function parseWith<T>(
  schema: ZodType<T>,
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(`Invalid ${what}`, {
    details: { target: what, ...issueDetails(result.error) },
    cause: result.error,
  });
}
