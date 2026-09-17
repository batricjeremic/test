import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import type { CallOptions } from '../ports.js';
import {
  checksumOf,
  isCliEntrypoint,
  loadMigrations,
  main,
  MIGRATION_LOCK_KEY,
  planMigrations,
  runMigrations,
  type AppliedMigration,
  type Migration,
} from './migrate.js';
import { createDatabaseOn } from './pool.js';
import { FakeSqlPool, RecordingLogger } from './test-support.js';

const options: CallOptions = { traceId: 'trace-migrate' };

const migration = (version: number, sql: string): Migration => ({
  version,
  name: `m${version}`,
  fileName: `000${version}_m${version}.sql`,
  checksum: checksumOf(sql),
  sql,
});

const appliedRow = (item: Migration): AppliedMigration => ({
  version: item.version,
  name: item.name,
  checksum: item.checksum,
});

describe('checksumOf', () => {
  it('ignores line endings so a Windows checkout is not a mismatch', () => {
    expect(checksumOf('CREATE TABLE x;\r\n')).toBe(
      checksumOf('CREATE TABLE x;\n'),
    );
  });

  it('changes when the SQL changes', () => {
    expect(checksumOf('CREATE TABLE x;')).not.toBe(
      checksumOf('CREATE TABLE y;'),
    );
  });
});

describe('loadMigrations', () => {
  it('loads the shipped migrations in ascending version order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.name).toBe('init');
    const versions = migrations.map((item) => item.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(migrations[0]?.sql).toContain('CREATE TABLE board_definition');
  });
});

describe('planMigrations', () => {
  it('returns only the unapplied migrations, in order', () => {
    const first = migration(1, 'CREATE TABLE a;');
    const second = migration(2, 'CREATE TABLE b;');
    const third = migration(3, 'CREATE TABLE c;');
    expect(
      planMigrations(
        [third, first, second].sort((l, r) => l.version - r.version),
        [appliedRow(first)],
      ).map((item) => item.version),
    ).toEqual([2, 3]);
  });

  it('refuses to run when an applied migration changed on disk', () => {
    const first = migration(1, 'CREATE TABLE a;');
    const edited = { ...first, checksum: checksumOf('CREATE TABLE edited;') };
    expect(() => planMigrations([edited], [appliedRow(first)])).toThrow(
      ConfigError,
    );
  });

  it('refuses to run when an applied migration is missing from disk', () => {
    const first = migration(1, 'CREATE TABLE a;');
    expect(() => planMigrations([], [appliedRow(first)])).toThrow(ConfigError);
  });
});

describe('runMigrations', () => {
  it('locks, applies each pending file in its own transaction, unlocks', async () => {
    const pool = new FakeSqlPool(() => []);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    const result = await runMigrations(
      db,
      [migration(1, 'CREATE TABLE a;'), migration(2, 'CREATE TABLE b;')],
      new RecordingLogger(),
      options,
    );
    expect(result.applied).toEqual([1, 2]);
    const sql = pool.statements.map((item) => item.sql);
    expect(sql[0]).toContain('pg_advisory_lock');
    expect(pool.statements[0]?.params).toEqual([MIGRATION_LOCK_KEY]);
    expect(sql.at(-1)).toContain('pg_advisory_unlock');
    const order = pool.verbs();
    expect(order.filter((verb) => verb === 'BEGIN')).toHaveLength(2);
    expect(order.filter((verb) => verb === 'COMMIT')).toHaveLength(2);
    const beginIndex = order.indexOf('BEGIN');
    expect(sql[beginIndex + 1]).toBe('CREATE TABLE a;');
    expect(sql[beginIndex + 2]).toContain('INSERT INTO schema_migrations');
  });

  it('skips migrations the database already recorded', async () => {
    const first = migration(1, 'CREATE TABLE a;');
    const pool = new FakeSqlPool((sql) =>
      sql.includes('FROM schema_migrations') ? [appliedRow(first)] : [],
    );
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    const result = await runMigrations(
      db,
      [first, migration(2, 'CREATE TABLE b;')],
      new RecordingLogger(),
      options,
    );
    expect(result.applied).toEqual([2]);
    expect(result.alreadyApplied).toEqual([1]);
    expect(pool.statements.map((item) => item.sql)).not.toContain(
      'CREATE TABLE a;',
    );
  });

  it('aborts on a checksum change and still releases the lock', async () => {
    const first = migration(1, 'CREATE TABLE a;');
    const pool = new FakeSqlPool((sql) =>
      sql.includes('FROM schema_migrations') ? [appliedRow(first)] : [],
    );
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await expect(
      runMigrations(
        db,
        [migration(1, 'CREATE TABLE edited;')],
        new RecordingLogger(),
        options,
      ),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(pool.statements.at(-1)?.sql).toContain('pg_advisory_unlock');
  });

  it('rolls back the failing migration and stops', async () => {
    const pool = new FakeSqlPool((sql) => {
      if (sql === 'CREATE TABLE b;') throw new Error('syntax error');
      return [];
    });
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await expect(
      runMigrations(
        db,
        [migration(1, 'CREATE TABLE a;'), migration(2, 'CREATE TABLE b;')],
        new RecordingLogger(),
        options,
      ),
    ).rejects.toThrow();
    const order = pool.verbs();
    expect(order).toContain('ROLLBACK');
    expect(order.filter((verb) => verb === 'COMMIT')).toHaveLength(1);
    expect(pool.statements.at(-1)?.sql).toContain('pg_advisory_unlock');
  });
});

describe('CLI guard', () => {
  it('is not an entry point when another module started the process', () => {
    expect(isCliEntrypoint(['node', '/app/dist/server.js'])).toBe(false);
    expect(isCliEntrypoint(['node'])).toBe(false);
  });

  it('refuses to migrate when called from something that is not the CLI', async () => {
    await expect(
      main(['node', '/app/dist/server.js'], {}),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
