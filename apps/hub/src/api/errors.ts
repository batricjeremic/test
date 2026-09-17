/**
 * Transport errors.
 *
 * Nothing above this module ever sees a `Response`: a failed call is an
 * `ApiClientError` carrying the BFF's `ApiError` envelope when there was
 * one, and the trace id either way so a hub failure can be matched to a
 * BFF log line.
 */
import { apiErrorSchema } from '@eg/shared';
import type { ApiError } from '@eg/shared';

export type ApiErrorKind =
  /** Non-2xx response. `status` is set. */
  | 'http'
  /** The request never reached the BFF. */
  | 'network'
  /** Our own AbortSignal timeout fired. */
  | 'timeout'
  /** The caller aborted, e.g. the component unmounted. */
  | 'aborted'
  /** 2xx whose body did not parse against the shared Zod schema. */
  | 'invalid-response';

export type ApiClientErrorInit = {
  kind: ApiErrorKind;
  message: string;
  traceId: string;
  status?: number | null;
  apiError?: ApiError | null;
  retryAfterSeconds?: number | null;
  cause?: unknown;
};

export class ApiClientError extends Error {
  public override readonly name = 'ApiClientError';
  public readonly kind: ApiErrorKind;
  public readonly status: number | null;
  public readonly apiError: ApiError | null;
  public readonly traceId: string;
  public readonly retryAfterSeconds: number | null;

  public constructor(init: ApiClientErrorInit) {
    super(init.message, { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.apiError = init.apiError ?? null;
    this.traceId = init.traceId;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  /** True when a retry could plausibly succeed. */
  public get retryable(): boolean {
    if (this.kind === 'network' || this.kind === 'timeout') return true;
    if (this.status === null) return false;
    return this.status === 429 || this.status >= 500;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/** A message safe to show a user, preferring the BFF's own wording. */
export function describeApiError(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.apiError) return error.apiError.message;
    switch (error.kind) {
      case 'timeout':
        return 'The board service did not answer in time.';
      case 'network':
        return 'The board service could not be reached.';
      case 'invalid-response':
        return 'The board service returned something we could not read.';
      case 'aborted':
        return 'The request was cancelled.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : 'Unexpected error.';
}

/** Parses a non-2xx body into the shared `ApiError`, or null. */
export function parseApiErrorBody(body: unknown): ApiError | null {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
