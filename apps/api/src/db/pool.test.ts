import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InternalError,
  ServiceUnavailableError,
  UpstreamTimeoutError,
  ValidationError,
} from '../errors.js';
import type { CallOptions } from '../ports.js';
import {
  createDatabaseOn,
  describeStatement,
  mapDatabaseError,
  type SqlResult,
} from './pool.js';
import { FakeSqlPool, RecordingLogger } from './test-support.js';

const options: CallOptions = { traceId: 'trace-1' };
const rowSchema = z.object({ id: z.string() });

describe('Database', () => {
  it('returns validated rows for a parameterised query', async () => {
    const pool = new FakeSqlPool(() => [{ id: 'b1' }]);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    const rows = await db.query(
      'SELECT id FROM board_definition WHERE org_id = $1',
      ['expertgroup'],
      rowSchema,
      options,
    );
    expect(rows).toEqual([{ id: 'b1' }]);
    expect(pool.statements[0]?.params).toEqual(['expertgroup']);
  });

  it('treats a row of the wrong shape as an internal error', async () => {
    const pool = new FakeSqlPool(() => [{ id: 42 }]);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await expect(
      db.query('SELECT id FROM board_definition', [], rowSchema, options),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it('never logs the parameter values', async () => {
    const logger = new RecordingLogger();
    const pool = new FakeSqlPool(() => [{ id: 'b1' }]);
    const db = createDatabaseOn(pool, logger, 1000, pool);
    await db.query('SELECT id FROM x WHERE a = $1', ['Ana'], rowSchema, {
      traceId: 'trace-9',
    });
    const line = logger.lines.at(-1);
    expect(line?.fields).toMatchObject({ paramCount: 1 });
    expect(JSON.stringify(logger.lines)).not.toContain('Ana');
  });

  it('times out instead of awaiting a wedged statement forever', async () => {
    const stalled = {
      query: (): Promise<SqlResult> => new Promise(() => {}),
    };
    const db = createDatabaseOn(stalled, new RecordingLogger(), 5);
    await expect(
      db.execute('SELECT pg_sleep(60)', [], options),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('honours a per-call timeout override', async () => {
    const stalled = {
      query: (): Promise<SqlResult> => new Promise(() => {}),
    };
    const db = createDatabaseOn(stalled, new RecordingLogger(), 60_000);
    await expect(
      db.execute('SELECT 1', [], { traceId: 'trace-1', timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('commits a transaction on one connection and releases it', async () => {
    const pool = new FakeSqlPool(() => []);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await db.transaction(async (tx) => {
      await tx.execute(
        'DELETE FROM board_source WHERE board_id = $1',
        ['b1'],
        options,
      );
    }, options);
    expect(pool.verbs()).toEqual(['BEGIN', 'DELETE FROM', 'COMMIT']);
    expect(pool.released).toHaveLength(1);
  });

  it('rolls back and rethrows when the body fails', async () => {
    const pool = new FakeSqlPool(() => []);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await expect(
      db.transaction(async () => {
        throw new ValidationError('bad input');
      }, options),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(pool.verbs()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pool.released).toHaveLength(1);
  });

  it('joins an outer transaction rather than nesting BEGIN', async () => {
    const pool = new FakeSqlPool(() => []);
    const db = createDatabaseOn(pool, new RecordingLogger(), 1000, pool);
    await db.transaction(
      async (tx) =>
        tx.transaction(async (inner) => {
          await inner.execute('SELECT 1', [], options);
        }, options),
      options,
    );
    expect(pool.verbs()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });
});

describe('mapDatabaseError', () => {
  it('maps a constraint violation to a validation error', () => {
    expect(mapDatabaseError({ code: '23505' }, 'insert into')).toBeInstanceOf(
      ValidationError,
    );
  });

  it('maps a deadlock to service unavailable', () => {
    expect(mapDatabaseError({ code: '40P01' }, 'update')).toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('maps a cancelled statement to an upstream timeout', () => {
    expect(mapDatabaseError({ code: '57014' }, 'select')).toBeInstanceOf(
      UpstreamTimeoutError,
    );
  });

  it('falls back to an internal error', () => {
    expect(mapDatabaseError(new Error('boom'), 'select')).toBeInstanceOf(
      InternalError,
    );
  });
});

describe('describeStatement', () => {
  it('keeps only the first two words, so nothing private is logged', () => {
    expect(describeStatement('  SELECT id FROM board WHERE name = $1 ')).toBe(
      'select id',
    );
  });
});
