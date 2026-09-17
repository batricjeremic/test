/**
 * Fakes for the cache tests. Nothing here opens a socket: every test in
 * this folder runs against an in-memory keyspace, as the ExpertGroup
 * testing rule requires.
 */
import type { LogFields, Logger } from '../ports.js';
import type { RedisLike } from './client.js';

export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that records instead of writing. */
export class RecordingLogger implements Logger {
  readonly traceId: string;
  readonly lines: LoggedLine[];
  private readonly bindings: LogFields;

  constructor(
    traceId = 'trace-test',
    lines: LoggedLine[] = [],
    bindings: LogFields = {},
  ) {
    this.traceId = traceId;
    this.lines = lines;
    this.bindings = bindings;
  }

  child(bindings: LogFields): Logger {
    return new RecordingLogger(this.traceId, this.lines, {
      ...this.bindings,
      ...bindings,
    });
  }

  withTraceId(traceId: string): Logger {
    return new RecordingLogger(traceId, this.lines, this.bindings);
  }

  private write(level: string, message: string, fields?: LogFields): void {
    this.lines.push({
      level,
      message,
      fields: { ...this.bindings, ...(fields ?? {}) },
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  /** Every line whose message matches, in order. */
  matching(message: string): LoggedLine[] {
    return this.lines.filter((line) => line.message === message);
  }
}

export interface RecordedCommand {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** Turns a Redis glob into a matcher. Supports `*` and `?`, as we use. */
export const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`);
};

/**
 * An in-memory Redis. Records every command, remembers the TTL each key
 * was written with, and can be told to fail or to hang so the degraded
 * and timeout paths are exercised without a real server.
 */
export class FakeRedis implements RedisLike {
  readonly commands: RecordedCommand[] = [];
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number | null>();
  /** When set, every command rejects with this error. */
  failure: Error | null = null;
  /** When true, every command never settles. */
  hang = false;
  quitCalls = 0;

  private record(name: string, args: readonly unknown[]): void {
    this.commands.push({ name, args });
  }

  private async guard<T>(value: T): Promise<T> {
    if (this.hang) return new Promise<T>(() => {});
    if (this.failure !== null) throw this.failure;
    return value;
  }

  async get(key: string): Promise<string | null> {
    this.record('get', [key]);
    return this.guard(this.values.get(key) ?? null);
  }

  async set(key: string, value: string): Promise<unknown> {
    this.record('set', [key, value]);
    const result = await this.guard('OK');
    this.values.set(key, value);
    this.ttls.set(key, null);
    return result;
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    this.record('setex', [key, seconds, value]);
    const result = await this.guard('OK');
    this.values.set(key, value);
    this.ttls.set(key, seconds);
    return result;
  }

  async del(...keys: string[]): Promise<number> {
    this.record('del', keys);
    await this.guard(null);
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        this.ttls.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async scan(
    cursor: string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    this.record('scan', [cursor, pattern, count]);
    await this.guard(null);
    const keys = [...this.values.keys()];
    const start = Number(cursor);
    const slice = keys.slice(start, start + count);
    const next = start + count >= keys.length ? '0' : String(start + count);
    const matcher = globToRegExp(pattern);
    return [next, slice.filter((key) => matcher.test(key))];
  }

  async quit(): Promise<unknown> {
    this.quitCalls += 1;
    return 'OK';
  }

  /** Command names in order, for asserting that nothing was attempted. */
  names(): string[] {
    return this.commands.map((command) => command.name);
  }
}

/** A clock the tests move by hand. */
export class TestClock {
  private current: number;

  constructor(start = Date.parse('2026-09-17T09:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
