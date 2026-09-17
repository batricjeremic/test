/**
 * Postgres access: a pool with explicit connection and statement
 * timeouts, and a typed, parameterised query helper.
 *
 * ExpertGroup rules this file exists to enforce:
 *  - every outbound call has an explicit timeout, so no query can hang
 *    a request forever;
 *  - parameterised queries only, never string interpolation;
 *  - structured logging with a trace id, and never the parameters --
 *    they carry display names and descriptors.
 */
import pg from 'pg';
import type { ZodType, ZodTypeDef } from 'zod';
import type { CallOptions, Logger } from '../ports.js';
import {
  InternalError,
  ServiceUnavailableError,
  UpstreamTimeoutError,
  ValidationError,
} from '../errors.js';

/**
 * A schema whose *input* is an unknown driver row and whose output is
 * the typed row, so a column that arrives as a string can be coerced.
 */
export type RowSchema<TRow> = ZodType<TRow, ZodTypeDef, unknown>;

/** Result shape of one statement, narrowed to what we use. */
export interface SqlResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

/**
 * The narrowest thing a query can run on: a pool, a pooled client, or a
 * fake in a test. Deliberately not `pg.Pool`, so nothing here needs a
 * live Postgres.
 */
export interface SqlExecutor {
  query(text: string, values: readonly unknown[]): Promise<SqlResult>;
}

/** An executor that can also hand out a dedicated connection. */
export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

/** Statement-level access to the config store. */
export interface Database {
  /** Rows validated with `rowSchema`; a bad shape is an error, not data. */
  query<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
    options: CallOptions,
  ): Promise<TRow[]>;

  /** The single row, or null when the statement returned none. */
  queryOne<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
    options: CallOptions,
  ): Promise<TRow | null>;

  /** Affected row count for a statement with no useful result set. */
  execute(
    sql: string,
    params: readonly unknown[],
    options: CallOptions,
  ): Promise<number>;

  /**
   * Runs `body` inside one transaction on one connection. Rolls back on
   * any rejection. Nested calls join the outer transaction.
   */
  transaction<T>(
    body: (tx: Database) => Promise<T>,
    options: CallOptions,
  ): Promise<T>;

  /** Closes the pool. Only the process owner calls this. */
  close(): Promise<void>;
}

export interface DatabaseConfig {
  readonly url: string;
  readonly requestTimeoutMs: number;
  /** Maximum pooled connections. Defaults to 10. */
  readonly maxConnections?: number;
}

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_SERIALIZATION_FAILURE = '40001';
const PG_DEADLOCK_DETECTED = '40P01';
const PG_QUERY_CANCELED = '57014';
const PG_ADMIN_SHUTDOWN = '57P01';
const PG_CANNOT_CONNECT = '08006';

const errorCodeOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

/**
 * Turns a driver error into the taxonomy. The Postgres message may name
 * a constraint, which is safe; it never carries our parameters.
 */
export function mapDatabaseError(error: unknown, operation: string): Error {
  const code = errorCodeOf(error);
  const message = `database ${operation} failed${
    code === null ? '' : ` (${code})`
  }`;
  switch (code) {
    case PG_UNIQUE_VIOLATION:
    case PG_FOREIGN_KEY_VIOLATION:
    case PG_CHECK_VIOLATION:
    case PG_NOT_NULL_VIOLATION:
      return new ValidationError(message, {
        cause: error,
        details: { operation, pgCode: code },
      });
    case PG_SERIALIZATION_FAILURE:
    case PG_DEADLOCK_DETECTED:
    case PG_ADMIN_SHUTDOWN:
    case PG_CANNOT_CONNECT:
      return new ServiceUnavailableError(message, null, {
        cause: error,
        details: { operation, pgCode: code },
      });
    case PG_QUERY_CANCELED:
      return new UpstreamTimeoutError(message, 0, {
        cause: error,
        details: { operation },
      });
    default:
      return new InternalError(message, {
        cause: error,
        details: { operation, pgCode: code },
      });
  }
}

/* ------------------------------------------------------------------ */
/* Timeout                                                             */
/* ------------------------------------------------------------------ */

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new UpstreamTimeoutError(
          `database ${operation} timed out after ${timeoutMs}ms`,
          timeoutMs,
          { details: { operation } },
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

interface PgDatabaseDeps {
  readonly executor: SqlExecutor;
  readonly pool: SqlPool | null;
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly inTransaction: boolean;
}

class PgDatabase implements Database {
  private readonly deps: PgDatabaseDeps;

  constructor(deps: PgDatabaseDeps) {
    this.deps = deps;
  }

  private log(options: CallOptions): Logger {
    return this.deps.logger.withTraceId(options.traceId);
  }

  private async run(
    sql: string,
    params: readonly unknown[],
    options: CallOptions,
  ): Promise<SqlResult> {
    const operation = describeStatement(sql);
    const timeoutMs = options.timeoutMs ?? this.deps.timeoutMs;
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        this.deps.executor.query(sql, params),
        timeoutMs,
        operation,
      );
      this.log(options).debug('database statement', {
        operation,
        rowCount: result.rowCount,
        durationMs: Date.now() - startedAt,
        paramCount: params.length,
      });
      return result;
    } catch (error) {
      if (error instanceof UpstreamTimeoutError) throw error;
      this.log(options).warn('database statement failed', {
        operation,
        durationMs: Date.now() - startedAt,
        pgCode: errorCodeOf(error),
      });
      throw mapDatabaseError(error, operation);
    }
  }

  async query<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
    options: CallOptions,
  ): Promise<TRow[]> {
    const result = await this.run(sql, params, options);
    return result.rows.map((row) => parseRow(rowSchema, row, sql));
  }

  async queryOne<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
    options: CallOptions,
  ): Promise<TRow | null> {
    const rows = await this.query(sql, params, rowSchema, options);
    const first = rows[0];
    return first === undefined ? null : first;
  }

  async execute(
    sql: string,
    params: readonly unknown[],
    options: CallOptions,
  ): Promise<number> {
    const result = await this.run(sql, params, options);
    return result.rowCount ?? 0;
  }

  async transaction<T>(
    body: (tx: Database) => Promise<T>,
    options: CallOptions,
  ): Promise<T> {
    if (this.deps.inTransaction) return body(this);
    const pool = this.deps.pool;
    if (pool === null) {
      throw new InternalError('transaction requires a pooled database');
    }
    const connection = await withTimeout(
      pool.connect(),
      options.timeoutMs ?? this.deps.timeoutMs,
      'connect',
    );
    const tx = new PgDatabase({
      executor: connection,
      pool: null,
      logger: this.deps.logger,
      timeoutMs: this.deps.timeoutMs,
      inTransaction: true,
    });
    try {
      await tx.execute('BEGIN', [], options);
      const value = await body(tx);
      await tx.execute('COMMIT', [], options);
      return value;
    } catch (error) {
      try {
        await tx.execute('ROLLBACK', [], options);
      } catch {
        this.log(options).warn('transaction rollback failed');
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    if (this.deps.pool !== null) await this.deps.pool.end();
  }
}

/** First two words of the statement, safe to log. */
export function describeStatement(sql: string): string {
  const words = sql.trim().split(/\s+/u).slice(0, 2);
  return words.join(' ').toLowerCase();
}

function parseRow<TRow>(
  rowSchema: RowSchema<TRow>,
  row: unknown,
  sql: string,
): TRow {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new InternalError('database row failed validation', {
      cause: parsed.error,
      details: { operation: describeStatement(sql) },
    });
  }
  return parsed.data;
}

/** Wraps an executor (a pool, a client, or a fake) as a `Database`. */
export function createDatabaseOn(
  executor: SqlExecutor,
  logger: Logger,
  timeoutMs: number,
  pool: SqlPool | null = null,
): Database {
  return new PgDatabase({
    executor,
    pool,
    logger,
    timeoutMs,
    inTransaction: false,
  });
}

/** Adapts a `pg.Pool` to `SqlPool`. */
export function adaptPgPool(pool: pg.Pool): SqlPool {
  return {
    query: (text, values) => pool.query(text, values as unknown[]),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, values) => client.query(text, values as unknown[]),
        release: () => {
          client.release();
        },
      };
    },
    end: () => pool.end(),
  };
}

/**
 * Builds the real pool. Connection, statement and idle-transaction
 * timeouts are all explicit, so a wedged server cannot pin a connection.
 */
export function createPool(config: DatabaseConfig): SqlPool {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: config.requestTimeoutMs,
    statement_timeout: config.requestTimeoutMs,
    query_timeout: config.requestTimeoutMs,
    idle_in_transaction_session_timeout: config.requestTimeoutMs,
    application_name: 'eg-board-api',
  });
  return adaptPgPool(pool);
}

export function createDatabase(
  config: DatabaseConfig,
  logger: Logger,
): Database {
  const pool = createPool(config);
  return createDatabaseOn(
    pool,
    logger.child({ component: 'db' }),
    config.requestTimeoutMs,
    pool,
  );
}
