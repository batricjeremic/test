/**
 * The one module that touches undici.
 *
 * Everything above it talks to `HttpTransport`, a function from a fully
 * described request to a fully read response, so the client's tests
 * inject a fake and never open a socket. The real implementation sets
 * both `headersTimeout` and `bodyTimeout` on every call, which is how
 * the ExpertGroup "explicit timeout on every outbound call" rule is met
 * for a streaming client: a response that starts and then stalls is
 * still bounded.
 */
import { request as undiciRequest } from 'undici';
import type { Dispatcher } from 'undici';
import type { AdoHeaderBag } from './types.js';

export type AdoHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AdoHttpRequest {
  readonly method: AdoHttpMethod;
  readonly url: string;
  /** Already includes authorization. Never log this object. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface AdoHttpResponse {
  readonly statusCode: number;
  readonly headers: AdoHeaderBag;
  /** Fully read body text. Empty string for a 204. */
  readonly body: string;
}

export type HttpTransport = (
  request: AdoHttpRequest,
) => Promise<AdoHttpResponse>;

/** Header names are matched case-insensitively everywhere downstream. */
export function lowerCaseHeaders(headers: AdoHeaderBag): AdoHeaderBag {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export interface UndiciTransportOptions {
  /** Injectable for tests and for pooling; undici's global by default. */
  readonly dispatcher?: Dispatcher;
}

export function createUndiciTransport(
  options: UndiciTransportOptions = {},
): HttpTransport {
  return async (request: AdoHttpRequest): Promise<AdoHttpResponse> => {
    const response = await undiciRequest(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      headersTimeout: request.headersTimeoutMs,
      bodyTimeout: request.bodyTimeoutMs,
      signal: request.signal,
      ...(options.dispatcher === undefined
        ? {}
        : { dispatcher: options.dispatcher }),
    });
    const body = await response.body.text();
    return {
      statusCode: response.statusCode,
      headers: lowerCaseHeaders(response.headers),
      body,
    };
  };
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ABORT_ERR',
  'ETIMEDOUT',
]);

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

/** True for "we ran out of time", whether undici or an AbortSignal said so. */
export function isTimeoutError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== null && TIMEOUT_CODES.has(code)) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  return false;
}
