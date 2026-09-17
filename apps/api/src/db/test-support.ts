/**
 * Fakes shared by the database tests. Nothing here talks to Postgres:
 * every test in this folder runs against an in-memory executor.
 */
import type { LogFields, Logger } from '../ports.js';
import type { SqlConnection, SqlPool, SqlResult } from './pool.js';

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
}

export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers a statement with rows, or throws to simulate a driver error. */
export type StatementHandler = (
  sql: string,
  params: readonly unknown[],
) => readonly unknown[];

/** An in-memory `SqlPool` that records every statement it is given. */
export class FakeSqlPool implements SqlPool {
  readonly statements: RecordedStatement[] = [];
  readonly released: number[] = [];
  ended = false;
  private readonly handler: StatementHandler;

  constructor(handler: StatementHandler = () => []) {
    this.handler = handler;
  }

  async query(text: string, values: readonly unknown[]): Promise<SqlResult> {
    this.statements.push({ sql: text, params: [...values] });
    const rows = this.handler(text, values);
    return { rows, rowCount: rows.length };
  }

  async connect(): Promise<SqlConnection> {
    const index = this.statements.length;
    return {
      query: (text, values) => this.query(text, values),
      release: () => {
        this.released.push(index);
      },
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  /** The statements, trimmed to their first words, in order. */
  verbs(): string[] {
    return this.statements.map((statement) =>
      statement.sql.trim().split(/\s+/u).slice(0, 2).join(' '),
    );
  }
}
