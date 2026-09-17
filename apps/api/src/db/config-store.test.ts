import { describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError } from '../errors.js';
import type { CallOptions } from '../ports.js';
import { PostgresConfigStore, MAX_AUDIT_LIMIT } from './config-store.js';
import type { Database, RowSchema } from './pool.js';
import { RecordingLogger, type RecordedStatement } from './test-support.js';

const options: CallOptions = { traceId: 'trace-1' };

type Answer = (sql: string, params: readonly unknown[]) => unknown[];

/** A `Database` that answers from memory and records every statement. */
class FakeDatabase implements Database {
  readonly statements: RecordedStatement[] = [];
  private readonly answer: Answer;

  constructor(answer: Answer = () => []) {
    this.answer = answer;
  }

  private run(sql: string, params: readonly unknown[]): unknown[] {
    this.statements.push({ sql, params: [...params] });
    return this.answer(sql, params);
  }

  async query<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
  ): Promise<TRow[]> {
    return this.run(sql, params).map((row) => rowSchema.parse(row));
  }

  async queryOne<TRow>(
    sql: string,
    params: readonly unknown[],
    rowSchema: RowSchema<TRow>,
  ): Promise<TRow | null> {
    const rows = this.run(sql, params).map((row) => rowSchema.parse(row));
    const first = rows[0];
    return first === undefined ? null : first;
  }

  async execute(sql: string, params: readonly unknown[]): Promise<number> {
    return this.run(sql, params).length;
  }

  async transaction<T>(body: (tx: Database) => Promise<T>): Promise<T> {
    this.statements.push({ sql: 'BEGIN', params: [] });
    const value = await body(this);
    this.statements.push({ sql: 'COMMIT', params: [] });
    return value;
  }

  async close(): Promise<void> {}

  sqlAt(index: number): string {
    return this.statements[index]?.sql ?? '';
  }

  paramsAt(index: number): readonly unknown[] {
    return this.statements[index]?.params ?? [];
  }
}

const storeOn = (db: Database): PostgresConfigStore =>
  new PostgresConfigStore(db, new RecordingLogger());

const boardRow = {
  id: 'b1',
  name: 'Delivery',
  org_id: 'expertgroup',
  default_grouping: 'person',
  owner_descriptor: 'aad.owner',
};

describe('board definitions', () => {
  it('lists a board definition as the shared DTO', async () => {
    const db = new FakeDatabase(() => [boardRow]);
    const boards = await storeOn(db).listBoardDefinitions(
      'expertgroup',
      options,
    );
    expect(boards).toEqual([
      {
        id: 'b1',
        name: 'Delivery',
        orgId: 'expertgroup',
        defaultGrouping: 'person',
        ownerDescriptor: 'aad.owner',
      },
    ]);
    expect(db.paramsAt(0)).toEqual(['expertgroup']);
  });

  it('returns null for a board that does not exist', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).getBoardDefinition('missing', options),
    ).resolves.toBeNull();
  });

  it('patches only the fields the admin sent', async () => {
    const db = new FakeDatabase(() => [{ ...boardRow, name: 'Renamed' }]);
    const updated = await storeOn(db).updateBoardDefinition(
      'b1',
      { name: 'Renamed' },
      options,
    );
    expect(updated.name).toBe('Renamed');
    expect(db.sqlAt(0)).toContain('name = $2');
    expect(db.sqlAt(0)).not.toContain('default_grouping =');
    expect(db.paramsAt(0)).toEqual(['b1', 'Renamed']);
  });

  it('reads back when the patch is empty rather than writing', async () => {
    const db = new FakeDatabase(() => [boardRow]);
    await storeOn(db).updateBoardDefinition('b1', {}, options);
    expect(db.sqlAt(0)).toContain('SELECT');
  });

  it('reports a missing board on update and delete', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).updateBoardDefinition('b1', { name: 'x' }, options),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      storeOn(db).deleteBoardDefinition('b1', options),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('board sources', () => {
  it('replaces the whole set in one transaction', async () => {
    const row = {
      board_id: 'b1',
      project_id: 'p1',
      team_id: 't1',
      backlog_level: 'Microsoft.RequirementCategory',
    };
    const db = new FakeDatabase((sql) => (sql.includes('SELECT') ? [row] : []));
    const sources = await storeOn(db).replaceBoardSources(
      'b1',
      [
        {
          boardId: 'b1',
          projectId: 'p1',
          teamId: 't1',
          backlogLevel: 'Microsoft.RequirementCategory',
        },
      ],
      options,
    );
    expect(sources).toHaveLength(1);
    const verbs = db.statements.map((item) => item.sql.trim().split(/\s+/u)[0]);
    expect(verbs).toEqual(['BEGIN', 'DELETE', 'INSERT', 'SELECT', 'COMMIT']);
  });

  it('refuses a source that belongs to another board', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).replaceBoardSources(
        'b1',
        [
          {
            boardId: 'other',
            projectId: 'p1',
            teamId: 't1',
            backlogLevel: 'Microsoft.RequirementCategory',
          },
        ],
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('canonical columns', () => {
  const column = (id: string, order: number) => ({
    id,
    boardId: 'b1',
    name: `Column ${order}`,
    order,
    stateCategory: 'InProgress' as const,
  });

  it('upserts the set and removes the columns no longer in it', async () => {
    const db = new FakeDatabase((sql) =>
      sql.includes('SELECT')
        ? [
            {
              id: 'c1',
              board_id: 'b1',
              name: 'Column 0',
              order: 0,
              state_category: 'InProgress',
            },
          ]
        : [],
    );
    const columns = await storeOn(db).replaceCanonicalColumns(
      'b1',
      [column('c1', 0)],
      options,
    );
    expect(columns).toHaveLength(1);
    expect(db.sqlAt(1)).toContain('id <> ALL($2::uuid[])');
    expect(db.paramsAt(1)).toEqual(['b1', ['c1']]);
    expect(db.sqlAt(2)).toContain('ON CONFLICT (id) DO UPDATE');
  });

  it('refuses a duplicate order, which the board could not render', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).replaceCanonicalColumns(
        'b1',
        [column('c1', 0), column('c2', 0)],
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses an order that is not contiguous from zero', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).replaceCanonicalColumns(
        'b1',
        [column('c1', 0), column('c2', 5)],
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('column mappings and person overrides', () => {
  it('upserts a mapping on (board, team, source column)', async () => {
    const row = {
      board_id: 'b1',
      team_id: 't1',
      source_column_id: 'In Review',
      canonical_column_id: 'c2',
      target_state: 'Active',
    };
    const db = new FakeDatabase(() => [row]);
    const mapping = await storeOn(db).upsertColumnMapping(
      {
        boardId: 'b1',
        teamId: 't1',
        sourceColumnId: 'In Review',
        canonicalColumnId: 'c2',
        targetState: 'Active',
      },
      options,
    );
    expect(mapping.targetState).toBe('Active');
    expect(db.sqlAt(0)).toContain(
      'ON CONFLICT (board_id, team_id, source_column_id)',
    );
  });

  it('deletes a mapping idempotently', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).deleteColumnMapping('b1', 't1', 'In Review', options),
    ).resolves.toBeUndefined();
    expect(db.paramsAt(0)).toEqual(['b1', 't1', 'In Review']);
  });

  it('upserts a person override on (board, descriptor)', async () => {
    const db = new FakeDatabase(() => [
      {
        board_id: 'b1',
        descriptor: 'aad.person',
        display_name: 'Contractor',
        hidden: true,
      },
    ]);
    const override = await storeOn(db).upsertPersonOverride(
      {
        boardId: 'b1',
        descriptor: 'aad.person',
        displayName: 'Contractor',
        hidden: true,
      },
      options,
    );
    expect(override.hidden).toBe(true);
    expect(db.sqlAt(0)).toContain('ON CONFLICT (board_id, descriptor)');
  });
});

describe('audit', () => {
  const successRow = {
    id: 'a1',
    board_id: 'b1',
    actor: 'aad.actor',
    work_item_id: 1234,
    from_column_id: 'c1',
    to_column_id: 'c2',
    result: { outcome: 'success', newRev: 8, stateChanged: true },
    occurred_at: '2026-09-17T08:00:00.000Z',
    trace_id: 'trace-1',
  };

  it('appends a success, denormalising the outcome columns', async () => {
    const db = new FakeDatabase(() => [successRow]);
    const entry = await storeOn(db).appendAudit(
      {
        boardId: 'b1',
        actor: 'aad.actor',
        workItemId: 1234,
        from: 'c1',
        to: 'c2',
        result: { outcome: 'success', newRev: 8, stateChanged: true },
        timestamp: '2026-09-17T08:00:00.000Z',
        traceId: 'trace-1',
      },
      options,
    );
    expect(entry.id).toBe('a1');
    const params = db.paramsAt(0);
    expect(params[5]).toBe('success');
    expect(params[6]).toBe(8);
    expect(params[7]).toBe(true);
    expect(params[8]).toBeNull();
    expect(params[9]).toBe(
      JSON.stringify({ outcome: 'success', newRev: 8, stateChanged: true }),
    );
  });

  it('appends a failed attempt too, with the reason queryable', async () => {
    const failure = {
      reason: 'rule-violation' as const,
      message: 'Effort is required to move to Done',
      field: 'Microsoft.VSTS.Scheduling.Effort',
      fieldDisplayName: 'Effort',
      targetState: 'Done',
      workItemUrl: 'https://dev.azure.com/eg/_workitems/edit/1234',
    };
    const db = new FakeDatabase(() => [
      { ...successRow, result: { outcome: 'failure', failure } },
    ]);
    const entry = await storeOn(db).appendAudit(
      {
        boardId: 'b1',
        actor: 'aad.actor',
        workItemId: 1234,
        from: 'c1',
        to: 'c2',
        result: { outcome: 'failure', failure },
        timestamp: '2026-09-17T08:00:00.000Z',
        traceId: 'trace-1',
      },
      options,
    );
    expect(entry.result.outcome).toBe('failure');
    const params = db.paramsAt(0);
    expect(params[5]).toBe('failure');
    expect(params[8]).toBe('rule-violation');
  });

  it('rejects an entry that is not a valid audit record', async () => {
    const db = new FakeDatabase(() => []);
    await expect(
      storeOn(db).appendAudit(
        {
          boardId: 'b1',
          actor: '',
          workItemId: 1234,
          from: 'c1',
          to: 'c2',
          result: { outcome: 'success', newRev: 1, stateChanged: false },
          timestamp: '2026-09-17T08:00:00.000Z',
          traceId: 'trace-1',
        },
        options,
      ),
    ).rejects.toThrow();
  });

  it('filters by work item, actor and time, all parameterised', async () => {
    const db = new FakeDatabase(() => [successRow]);
    await storeOn(db).listAudit(
      'b1',
      {
        workItemId: 1234,
        actor: 'aad.actor',
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-30T00:00:00.000Z',
        limit: 10,
      },
      options,
    );
    const sql = db.sqlAt(0);
    expect(sql).toContain('work_item_id = $2');
    expect(sql).toContain('actor = $3');
    expect(sql).toContain('occurred_at >= $4');
    expect(sql).toContain('occurred_at <= $5');
    expect(sql).toContain('LIMIT $6');
    expect(db.paramsAt(0)).toEqual([
      'b1',
      1234,
      'aad.actor',
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T00:00:00.000Z',
      10,
    ]);
  });

  it('caps the limit and rejects a nonsense one', async () => {
    const db = new FakeDatabase(() => []);
    await storeOn(db).listAudit('b1', { limit: 10_000 }, options);
    expect(db.paramsAt(0)[1]).toBe(MAX_AUDIT_LIMIT);
    await expect(
      storeOn(db).listAudit('b1', { limit: 0 }, options),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
