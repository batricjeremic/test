/**
 * Error taxonomy.
 *
 * Serves the failure table in the spec's "Write path" plus the general
 * request path: every error carries an HTTP status, a stable
 * machine-readable code and a message that is safe to show a user.
 *
 * `message` is for logs and may repeat what Azure DevOps said.
 * `userMessage` is for the toast. Neither ever carries a token.
 */
import type { ApiError } from '@eg/shared';
import {
  adoErrorResponseSchema,
  ADO_RATE_LIMIT_HEADERS,
  type AdoErrorResponse,
  type AdoHeaderBag,
} from './ado/types.js';

/** Stable, machine-readable. The hub may branch on these; never rename. */
export type AppErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'permission_denied'
  | 'not_found'
  | 'revision_conflict'
  | 'rule_violation'
  | 'transition_not_allowed'
  | 'mapping_missing'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_failed'
  | 'service_unavailable'
  | 'invalid_configuration'
  | 'internal_error';

export interface AppErrorOptions {
  /** Structured context for the log line. Never secrets, never names. */
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/** Base of the taxonomy. Concrete so a fake can construct one directly. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    status: number,
    message: string,
    userMessage: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.details = options.details ?? {};
  }

  /** The response body. `details` is included only when non-empty. */
  toApiError(traceId: string): ApiError {
    const hasDetails = Object.keys(this.details).length > 0;
    return {
      code: this.code,
      message: this.userMessage,
      status: this.status,
      traceId,
      ...(hasDetails ? { details: this.details } : {}),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** A request body, query or webhook payload failed its Zod parse. */
export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('validation_failed', 400, message, 'That request was not valid.', {
      ...options,
    });
  }
}

/** No token, an expired token, or one the Azure DevOps issuer rejects. */
export class UnauthorizedError extends AppError {
  constructor(
    message = 'Caller is not authenticated',
    options: AppErrorOptions = {},
  ) {
    super('unauthorized', 401, message, 'Please sign in again.', options);
  }
}

/** "User lacks write in that project" — and every read-side trim. */
export class PermissionDeniedError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(
      'permission_denied',
      403,
      message,
      'You do not have permission to do that in this project.',
      options,
    );
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('not_found', 404, message, 'That item no longer exists.', options);
  }
}

/** "Card changed since load" — the JSON Patch `test` op was rejected. */
export class RevisionConflictError extends AppError {
  readonly currentRev: number | null;
  constructor(
    message: string,
    currentRev: number | null = null,
    options: AppErrorOptions = {},
  ) {
    super(
      'revision_conflict',
      409,
      message,
      'Someone else changed this card. It has been refreshed.',
      options,
    );
    this.currentRev = currentRev;
  }
}

/** "Required field empty for the target state." */
export class RuleViolationError extends AppError {
  readonly field: string | null;
  constructor(
    message: string,
    field: string | null = null,
    options: AppErrorOptions = {},
  ) {
    super('rule_violation', 422, message, message, options);
    this.field = field;
  }
}

/** "Process forbids that state change." */
export class TransitionNotAllowedError extends AppError {
  readonly allowedStates: readonly string[];
  constructor(
    message: string,
    allowedStates: readonly string[] = [],
    options: AppErrorOptions = {},
  ) {
    super('transition_not_allowed', 422, message, message, options);
    this.allowedStates = allowedStates;
  }
}

/** "Target column not mapped for that team." Never guessed, always named. */
export class MappingMissingError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(
      'mapping_missing',
      409,
      message,
      'That column is not mapped for this team.',
      options,
    );
  }
}

/** Azure DevOps throttled us. `retryAfterSeconds` comes from the header. */
export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number | null;
  constructor(
    message: string,
    retryAfterSeconds: number | null = null,
    options: AppErrorOptions = {},
  ) {
    super(
      'rate_limited',
      429,
      message,
      'Azure DevOps is busy. Try again in a moment.',
      options,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** An outbound call hit its explicit timeout. */
export class UpstreamTimeoutError extends AppError {
  readonly timeoutMs: number;
  constructor(
    message: string,
    timeoutMs: number,
    options: AppErrorOptions = {},
  ) {
    super(
      'upstream_timeout',
      504,
      message,
      'Azure DevOps did not answer in time.',
      options,
    );
    this.timeoutMs = timeoutMs;
  }
}

/** Azure DevOps answered with something we cannot act on. */
export class UpstreamError extends AppError {
  readonly upstreamStatus: number;
  constructor(
    message: string,
    upstreamStatus: number,
    options: AppErrorOptions = {},
  ) {
    super(
      'upstream_failed',
      502,
      message,
      'Azure DevOps rejected that request.',
      options,
    );
    this.upstreamStatus = upstreamStatus;
  }
}

/** "Azure DevOps 5xx", or Redis and Postgres being unreachable. */
export class ServiceUnavailableError extends AppError {
  readonly retryAfterSeconds: number | null;
  constructor(
    message: string,
    retryAfterSeconds: number | null = null,
    options: AppErrorOptions = {},
  ) {
    super(
      'service_unavailable',
      503,
      message,
      'The service is busy. Your change was not saved.',
      options,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Environment configuration failed validation at startup. */
export class ConfigError extends AppError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    const message = `Invalid configuration:\n${issues
      .map((issue) => `  - ${issue}`)
      .join('\n')}`;
    super('invalid_configuration', 500, message, 'Misconfigured service.', {
      details: { issueCount: issues.length },
    });
    this.issues = issues;
  }
}

export class InternalError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('internal_error', 500, message, 'Something went wrong.', options);
  }
}

/* ------------------------------------------------------------------ */
/* Azure DevOps error mapping                                          */
/* ------------------------------------------------------------------ */

export interface AdoFailure {
  readonly status: number;
  /** Parsed JSON body, or the raw text, or undefined. */
  readonly body: unknown;
  readonly headers?: AdoHeaderBag;
  /** For the log line: which endpoint failed. Never a token. */
  readonly operation?: string;
}

const headerSeconds = (
  headers: AdoHeaderBag | undefined,
  name: string,
): number | null => {
  if (headers === undefined) return null;
  const raw = headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
};

const REVISION_KEYS = [
  'WorkItemRevisionMismatchException',
  'ConcurrentUpdateException',
];

/** The `test` op on `/rev` fails with a quoted word, hence the \W gap. */
const looksLikeRevisionConflict = (text: string): boolean =>
  /\btest\b\W{0,3}operation|revision mismatch|has been changed|updated by another/i.test(
    text,
  );

const looksLikeTransition = (text: string): boolean =>
  /transition|is not a valid state|not allowed to move/i.test(text);

/** Field reference name out of a rule message, when it names one. */
const extractField = (text: string): string | null => {
  const match = /'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/.exec(text);
  return match?.[1] ?? null;
};

/**
 * Maps one Azure DevOps error response onto the taxonomy. Order matters:
 * the body's `typeKey` is more precise than the status code, so it is
 * consulted first.
 */
export function mapAdoError(failure: AdoFailure): AppError {
  const parsed = adoErrorResponseSchema.safeParse(failure.body);
  const body: AdoErrorResponse = parsed.success ? parsed.data : {};
  const text = body.message ?? '';
  const typeKey = body.typeKey ?? '';
  const details: Record<string, unknown> = {
    upstreamStatus: failure.status,
    ...(typeKey === '' ? {} : { typeKey }),
    ...(failure.operation === undefined
      ? {}
      : { operation: failure.operation }),
  };
  const message = text === '' ? `Azure DevOps returned ${failure.status}` : text;
  const retryAfter = headerSeconds(
    failure.headers,
    ADO_RATE_LIMIT_HEADERS.retryAfter,
  );

  if (REVISION_KEYS.includes(typeKey) || looksLikeRevisionConflict(text)) {
    return new RevisionConflictError(message, null, { details });
  }
  if (typeKey === 'RuleValidationException' || failure.status === 422) {
    return looksLikeTransition(text)
      ? new TransitionNotAllowedError(message, [], { details })
      : new RuleViolationError(message, extractField(text), { details });
  }

  switch (failure.status) {
    case 401:
      return new UnauthorizedError(message, { details });
    case 403:
      return new PermissionDeniedError(message, { details });
    case 404:
      return new NotFoundError(message, { details });
    case 409:
    case 412:
      return new RevisionConflictError(message, null, { details });
    case 429:
      return new RateLimitedError(message, retryAfter, { details });
    default:
      break;
  }
  if (failure.status >= 500) {
    return new ServiceUnavailableError(message, retryAfter, { details });
  }
  if (failure.status === 400 && looksLikeTransition(text)) {
    return new TransitionNotAllowedError(message, [], { details });
  }
  if (failure.status === 400) {
    return new RuleViolationError(message, extractField(text), { details });
  }
  return new UpstreamError(message, failure.status, { details });
}

/** Last resort for the request error handler: never leak an unknown. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new InternalError(error.message, { cause: error });
  }
  return new InternalError('Unknown error');
}
