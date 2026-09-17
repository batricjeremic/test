/**
 * Migration runner, invoked as a CLI (`pnpm db:migrate`).
 *
 * ExpertGroup rule: migrations are applied by pipelines, never at
 * startup and never from a dev session. `main` therefore refuses to run
 * unless this module is the process entry point, so importing it from
 * the server can never apply a migration.
 *
 * Guarantees:
 *  - files run in ascending version order, each in its own transaction;
 *  - a session-level advisory lock serialises two pipeline runs;
 *  - an applied migration whose checksum changed aborts the run --
 *    applied files are immutable, fix mistakes with a new file.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseMigrationConfig, type MigrationConfig } from '../config.js';
import { ConfigError, toAppError } from '../errors.js';
import { createLogger, newTraceId } from '../logging.js';
import type { CallOptions, Logger } from '../ports.js';
import {
  createDatabaseOn,
  createPool,
  type Database,
  type SqlPool,
} from './pool.js';

/** Session-level advisory lock key. Arbitrary but fixed forever. */
export const MIGRATION_LOCK_KEY = 4179251001;

/** `0001_init.sql`: a four-digit version, an underscore, a name. */
const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/u;

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationRunResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
}

const appliedRowSchema = z.object({
  version: z.union([z.number(), z.string()]).transform(Number),
  name: z.string(),
  checksum: z.string(),
});

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms   INTEGER NOT NULL
)`;

/** Line-ending insensitive, so a checkout on Windows is not a mismatch. */
export function checksumOf(sql: string): string {
  const normalised = sql.replace(/\r\n/gu, '\n').trimEnd();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Reads every `NNNN_name.sql` in `dir`, ordered by version. Duplicate
 * versions are a configuration error, not a last-one-wins.
 */
export async function loadMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<Migration[]> {
  const entries = await readdir(dir);
  const issues: string[] = [];
  const migrations: Migration[] = [];
  const seen = new Map<number, string>();
  for (const entry of entries.filter((name) => name.endsWith('.sql'))) {
    const match = MIGRATION_FILE_PATTERN.exec(entry);
    if (match === null) {
      issues.push(`${entry}: not named NNNN_name.sql`);
      continue;
    }
    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      issues.push(`${entry}: not named NNNN_name.sql`);
      continue;
    }
    const version = Number(versionText);
    const clash = seen.get(version);
    if (clash !== undefined) {
      issues.push(`${entry}: duplicates version ${version} of ${clash}`);
      continue;
    }
    seen.set(version, entry);
    const sql = await readFile(join(dir, entry), 'utf8');
    migrations.push({
      version,
      name,
      fileName: entry,
      checksum: checksumOf(sql),
      sql,
    });
  }
  if (issues.length > 0) throw new ConfigError(issues.sort());
  migrations.sort((left, right) => left.version - right.version);
  return migrations;
}

/**
 * Compares what is on disk with what the database says it applied.
 * Returns the migrations still to run, in order.
 */
export function planMigrations(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): Migration[] {
  const byVersion = new Map(applied.map((row) => [row.version, row]));
  const issues: string[] = [];
  const pending: Migration[] = [];
  for (const migration of migrations) {
    const row = byVersion.get(migration.version);
    if (row === undefined) {
      pending.push(migration);
      continue;
    }
    byVersion.delete(migration.version);
    if (row.checksum !== migration.checksum) {
      issues.push(
        `${migration.fileName}: checksum changed after it was applied ` +
          '(applied migrations are immutable; add a new file)',
      );
    }
  }
  for (const row of byVersion.values()) {
    issues.push(`${row.version} (${row.name}): applied but missing from disk`);
  }
  if (issues.length > 0) throw new ConfigError(issues.sort());
  return pending;
}

/**
 * Applies every pending migration on one connection. `db` must be bound
 * to a single connection: the advisory lock is session-level.
 */
export async function runMigrations(
  db: Database,
  migrations: readonly Migration[],
  logger: Logger,
  options: CallOptions,
): Promise<MigrationRunResult> {
  const log = logger.withTraceId(options.traceId);
  await db.execute(
    'SELECT pg_advisory_lock($1)',
    [MIGRATION_LOCK_KEY],
    options,
  );
  try {
    await db.execute(CREATE_TABLE_SQL, [], options);
    const applied = await db.query(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      [],
      appliedRowSchema,
      options,
    );
    const pending = planMigrations(migrations, applied);
    log.info('migration plan', {
      onDisk: migrations.length,
      applied: applied.length,
      pending: pending.length,
    });
    for (const migration of pending) {
      const startedAt = Date.now();
      await db.execute('BEGIN', [], options);
      try {
        await db.execute(migration.sql, [], options);
        await db.execute(
          `INSERT INTO schema_migrations
             (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [
            migration.version,
            migration.name,
            migration.checksum,
            Date.now() - startedAt,
          ],
          options,
        );
        await db.execute('COMMIT', [], options);
      } catch (error) {
        await db.execute('ROLLBACK', [], options);
        log.error('migration failed', {
          version: migration.version,
          file: migration.fileName,
        });
        throw error;
      }
      log.info('migration applied', {
        version: migration.version,
        file: migration.fileName,
        durationMs: Date.now() - startedAt,
      });
    }
    return {
      applied: pending.map((migration) => migration.version),
      alreadyApplied: applied.map((row) => row.version),
    };
  } finally {
    await db.execute(
      'SELECT pg_advisory_unlock($1)',
      [MIGRATION_LOCK_KEY],
      options,
    );
  }
}

const withoutExtension = (path: string): string =>
  join(resolve(path, '..'), basename(path, extname(path)));

/**
 * True only when this module is the process entry point. The server
 * imports nothing from here, but this is the belt to that braces.
 */
export function isCliEntrypoint(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  const here = withoutExtension(fileURLToPath(import.meta.url));
  return here === withoutExtension(resolve(entry));
}

/**
 * CLI entry. Returns the process exit code. It throws only when it is
 * called from something that is not the CLI, which is the guard against
 * applying migrations from a running server.
 */
export async function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!isCliEntrypoint(argv)) {
    throw new ConfigError([
      'db:migrate may only run as a CLI; migrations are applied by ' +
        'pipelines, never at startup',
    ]);
  }
  const traceId = newTraceId();
  let config: MigrationConfig;
  try {
    config = parseMigrationConfig(env);
  } catch (error) {
    const failure = toAppError(error);
    createLogger({ level: 'info', traceId, name: 'db-migrate' }).error(
      'configuration is invalid',
      { code: failure.code, details: failure.details },
    );
    return 78;
  }
  const logger = createLogger({
    level: config.logLevel,
    traceId,
    name: 'db-migrate',
  });
  const options: CallOptions = {
    traceId,
    timeoutMs: Math.max(config.postgres.requestTimeoutMs, 60_000),
  };
  let pool: SqlPool | null = null;
  try {
    const migrations = await loadMigrations();
    pool = createPool({
      url: config.postgres.url,
      requestTimeoutMs: options.timeoutMs ?? config.postgres.requestTimeoutMs,
      maxConnections: 1,
    });
    const connection = await pool.connect();
    try {
      const db = createDatabaseOn(
        connection,
        logger,
        options.timeoutMs ?? config.postgres.requestTimeoutMs,
      );
      const result = await runMigrations(db, migrations, logger, options);
      logger.info('migrations complete', {
        applied: result.applied,
        alreadyApplied: result.alreadyApplied.length,
      });
    } finally {
      connection.release();
    }
    return 0;
  } catch (error) {
    const failure = toAppError(error);
    logger.error('migration run failed', {
      code: failure.code,
      details: failure.details,
    });
    return 1;
  } finally {
    if (pool !== null) await pool.end();
  }
}

if (isCliEntrypoint(process.argv)) {
  process.exitCode = await main();
}
