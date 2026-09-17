/**
 * pino-backed implementation of the `Logger` port.
 *
 * Serves the ExpertGroup logging standard and the spec's "Data at rest"
 * note: every line carries a trace id, and tokens, authorization headers
 * and personal data are redacted before they can reach a transport.
 * Redaction happens twice on purpose — once in `sanitizeLogFields`, which
 * walks nested objects and child bindings, and once in pino's own
 * `redact` option — because a log line is the easiest place to leak.
 */
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { DestinationStream, Logger as PinoInstance } from 'pino';
import type { LogFields, Logger, LogLevel } from './ports.js';

export const REDACTED = '[redacted]';

/**
 * Lower-cased field names whose value is never logged: credentials
 * first, then the personal data the spec says we process. Descriptors
 * and work item ids stay, which is what an investigation actually needs.
 */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'token',
  'bearer',
  'apikey',
  'api_key',
  'password',
  'pat',
  'secret',
  'servicetoken',
  'credential',
  'credentials',
  'connectionstring',
  'cookie',
  'set-cookie',
  'displayname',
  'uniquename',
  'principalname',
  'email',
  'mail',
  'imageurl',
];

/** Paths handed to pino's own redaction, for shapes we log by habit. */
export const REDACT_PATHS: readonly string[] = [
  'authorization',
  'token',
  'accessToken',
  'serviceToken',
  'password',
  'secret',
  'displayName',
  'uniqueName',
  'email',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.token',
  '*.accessToken',
  '*.serviceToken',
  '*.password',
  '*.secret',
  '*.displayName',
  '*.uniqueName',
  '*.email',
];

const MAX_DEPTH = 6;

const isSensitiveFieldName = (key: string): boolean =>
  SENSITIVE_FIELD_NAMES.includes(key.toLowerCase());

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const sanitizeValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  if (depth <= 0) return '[truncated]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((item) => sanitizeValue(item, depth - 1, seen));
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveFieldName(key)
        ? REDACTED
        : sanitizeValue(item, depth - 1, seen);
    }
    return out;
  }
  return value;
};

/**
 * Replaces the value of every sensitive key, at any depth, with
 * `[redacted]`. Cycles and over-deep objects are cut rather than thrown.
 */
export function sanitizeLogFields(fields: LogFields): Record<string, unknown> {
  const sanitized = sanitizeValue(fields, MAX_DEPTH, new WeakSet());
  return isPlainRecord(sanitized) ? sanitized : {};
}

/** A fresh correlation id, for a request or a worker run. */
export function newTraceId(): string {
  return randomUUID();
}

class PinoLogger implements Logger {
  readonly traceId: string;
  readonly #instance: PinoInstance;

  constructor(instance: PinoInstance, traceId: string) {
    this.#instance = instance;
    this.traceId = traceId;
  }

  child(bindings: LogFields): Logger {
    return new PinoLogger(
      this.#instance.child(sanitizeLogFields(bindings)),
      this.traceId,
    );
  }

  withTraceId(traceId: string): Logger {
    return new PinoLogger(this.#instance.child({ traceId }), traceId);
  }

  debug(message: string, fields?: LogFields): void {
    this.#instance.debug(sanitizeLogFields(fields ?? {}), message);
  }

  info(message: string, fields?: LogFields): void {
    this.#instance.info(sanitizeLogFields(fields ?? {}), message);
  }

  warn(message: string, fields?: LogFields): void {
    this.#instance.warn(sanitizeLogFields(fields ?? {}), message);
  }

  error(message: string, fields?: LogFields): void {
    this.#instance.error(sanitizeLogFields(fields ?? {}), message);
  }
}

export interface CreateLoggerOptions {
  readonly level: LogLevel;
  /** Omitted means a fresh id: no line is ever written without one. */
  readonly traceId?: string;
  readonly name?: string;
  /** Test seam. Defaults to stdout. */
  readonly destination?: DestinationStream;
  readonly base?: LogFields;
}

/** Builds the root logger. One per process; derive the rest with child. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const traceId = options.traceId ?? newTraceId();
  const pinoOptions = {
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: options.name ?? 'board-api',
      ...sanitizeLogFields(options.base ?? {}),
    },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
  const instance =
    options.destination === undefined
      ? pino(pinoOptions)
      : pino(pinoOptions, options.destination);
  return new PinoLogger(instance.child({ traceId }), traceId);
}

/** Wraps an existing pino instance, e.g. the one Fastify already holds. */
export function fromPino(instance: PinoInstance, traceId: string): Logger {
  return new PinoLogger(instance.child({ traceId }), traceId);
}
