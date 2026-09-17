/**
 * The one place the hub talks to the network.
 *
 * Every request carries the user's short-lived SDK token in the
 * Authorization header (never in the URL, never in a log line), a
 * correlation id so the action can be traced to a BFF log line, and an
 * explicit timeout via `AbortSignal`. Every 2xx body is parsed with the
 * Zod schema from `@eg/shared`; a body that does not parse is an error,
 * not a cast.
 */
import { TRACE_ID_HEADER } from '@eg/shared';
import type { output as ZodOutput, ZodTypeAny } from 'zod';
import { ApiClientError, parseApiErrorBody } from './errors';

/** Per-call overrides. */
export type RequestOptions = {
  /** Caller's abort signal, combined with the timeout signal. */
  signal?: AbortSignal;
  /** Overrides `HttpConfig.defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Reuses an existing correlation id instead of minting one. */
  traceId?: string;
};

export type HttpConfig = {
  /** BFF origin plus any path prefix, e.g. `https://board.eg.rs`. */
  baseUrl: string;
  /** Short-lived user token; called once per request, never cached here. */
  getAccessToken: () => Promise<string>;
  /** Injected in tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Timeout applied when the caller does not pass one. Default 15000. */
  defaultTimeoutMs?: number;
  /** Correlation id factory. Defaults to `crypto.randomUUID()`. */
  newTraceId?: () => string;
};

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Header the BFF reads to stitch a hub action to its log lines. */
export const CORRELATION_ID_HEADER: string = TRACE_ID_HEADER;

export type JsonRequest<S extends ZodTypeAny> = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path below `baseUrl`, starting with a slash. */
  path: string;
  /** Query string parameters; undefined values are dropped. */
  query?: URLSearchParams;
  /** JSON request body, serialised as-is. */
  body?: unknown;
  /** Schema the 2xx body must satisfy. */
  schema: S;
  options?: RequestOptions;
};

/** A parsed 2xx response plus the correlation id the call was made with. */
export type JsonResponse<T> = {
  data: T;
  traceId: string;
  status: number;
};

export function newTraceId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = Math.random().toString(16).slice(2);
  return `hub-${Date.now().toString(16)}-${random}`;
}

export async function requestJson<S extends ZodTypeAny>(
  config: HttpConfig,
  request: JsonRequest<S>,
): Promise<JsonResponse<ZodOutput<S>>> {
  const options = request.options ?? {};
  const traceId = options.traceId ?? (config.newTraceId ?? newTraceId)();
  const timeoutMs =
    options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = buildUrl(config.baseUrl, request.path, request.query);

  const token = await config.getAccessToken();
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    [CORRELATION_ID_HEADER]: traceId,
  });
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const deadline = createDeadline(timeoutMs, options.signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? null : JSON.stringify(request.body),
      credentials: 'omit',
      signal: deadline.signal,
    });
  } catch (cause) {
    if (deadline.timedOut) {
      throw new ApiClientError({
        kind: 'timeout',
        message: `Request timed out after ${timeoutMs}ms`,
        traceId,
        cause,
      });
    }
    if (options.signal?.aborted === true) {
      throw new ApiClientError({
        kind: 'aborted',
        message: 'Request aborted',
        traceId,
        cause,
      });
    }
    throw new ApiClientError({
      kind: 'network',
      message: 'The board service could not be reached',
      traceId,
      cause,
    });
  } finally {
    deadline.dispose();
  }

  const responseTraceId =
    response.headers.get(CORRELATION_ID_HEADER) ?? traceId;
  const payload = await readJsonBody(response);

  if (!response.ok) {
    const apiError = parseApiErrorBody(payload);
    throw new ApiClientError({
      kind: 'http',
      status: response.status,
      message:
        apiError?.message ??
        `The board service returned ${response.status} ${response.statusText}`,
      apiError,
      traceId: apiError?.traceId ?? responseTraceId,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  const parsed = request.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError({
      kind: 'invalid-response',
      status: response.status,
      message: `Response from ${request.path} did not match its schema`,
      traceId: responseTraceId,
      cause: parsed.error,
    });
  }

  return {
    data: parsed.data,
    traceId: responseTraceId,
    status: response.status,
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: URLSearchParams | undefined,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = query && [...query.keys()].length > 0 ? `?${query}` : '';
  return `${base}${path}${suffix}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

type Deadline = {
  signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
};

/**
 * Combines the caller's signal with our own timeout. Built by hand rather
 * than with `AbortSignal.any` so the timeout can be told apart from a
 * caller abort, and so nothing depends on a very recent runtime.
 */
function createDeadline(
  timeoutMs: number,
  external: AbortSignal | undefined,
): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}
