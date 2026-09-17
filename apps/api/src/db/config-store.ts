/**
 * The `ConfigStore` port over Postgres.
 *
 * Spec: "Domain model and column mapping" plus the audit rule in "Write
 * path" -- every write attempt is recorded, success or failure, because
 * the first support question will be "I moved that card and it went
 * back".
 *
 * Every statement is parameterised. Input crossing the process boundary
 * is validated with the shared Zod schemas before it reaches SQL, and
 * every row is validated again on the way out.
 */
import {
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  newAuditEntrySchema,
  personOverrideSchema,
  type AuditEntry,
  type BoardDefinition,
  type BoardSource,
  type CanonicalColumn,
  type ColumnMapping,
  type Descriptor,
  type NewAuditEntry,
  type PersonOverride,
} from '@eg/shared';
import { NotFoundError, ValidationError } from '../errors.js';
import type {
  AuditQuery,
  BoardDefinitionPatch,
  CallOptions,
  ConfigStore,
  Logger,
  NewBoardDefinition,
} from '../ports.js';
import type { Database } from './pool.js';
import {
  auditEntryRowSchema,
  auditResultColumns,
  boardDefinitionRowSchema,
  boardSourceRowSchema,
  canonicalColumnRowSchema,
  columnMappingRowSchema,
  personOverrideRowSchema,
  toAuditEntry,
  toBoardDefinition,
  toBoardSource,
  toCanonicalColumn,
  toColumnMapping,
  toPersonOverride,
} from './rows.js';

/** Default and ceiling for `listAudit`, so one query cannot read the log. */
export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

const BOARD_COLUMNS = `id, name, org_id, default_grouping, owner_descriptor`;
const SOURCE_COLUMNS = `board_id, project_id, team_id, backlog_level`;
const CANONICAL_COLUMNS = `id, board_id, name, "order", state_category`;
const MAPPING_COLUMNS = `board_id, team_id, source_column_id,
       canonical_column_id, target_state`;
const OVERRIDE_COLUMNS = `board_id, descriptor, display_name, hidden`;
const AUDIT_COLUMNS = `id, board_id, actor, work_item_id, from_column_id,
       to_column_id, result, occurred_at, trace_id`;

/** Fields an admin may patch, mapped to their column. Never user input. */
const BOARD_PATCH_COLUMNS = {
  name: 'name',
  defaultGrouping: 'default_grouping',
  ownerDescriptor: 'owner_descriptor',
} as const satisfies Record<keyof BoardDefinitionPatch, string>;

export class PostgresConfigStore implements ConfigStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'config-store' });
  }

  /* ---------------------------------------------------------------- */
  /* Board definitions                                                 */
  /* ---------------------------------------------------------------- */

  async listBoardDefinitions(
    orgId: string,
    options: CallOptions,
  ): Promise<BoardDefinition[]> {
    const rows = await this.db.query(
      `SELECT ${BOARD_COLUMNS} FROM board_definition
       WHERE org_id = $1 ORDER BY name ASC`,
      [orgId],
      boardDefinitionRowSchema,
      options,
    );
    return rows.map(toBoardDefinition);
  }

  async getBoardDefinition(
    boardId: string,
    options: CallOptions,
  ): Promise<BoardDefinition | null> {
    const row = await this.db.queryOne(
      `SELECT ${BOARD_COLUMNS} FROM board_definition WHERE id = $1`,
      [boardId],
      boardDefinitionRowSchema,
      options,
    );
    return row === null ? null : toBoardDefinition(row);
  }

  async createBoardDefinition(
    definition: NewBoardDefinition,
    options: CallOptions,
  ): Promise<BoardDefinition> {
    const row = await this.db.queryOne(
      `INSERT INTO board_definition
         (name, org_id, default_grouping, owner_descriptor)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BOARD_COLUMNS}`,
      [
        definition.name,
        definition.orgId,
        definition.defaultGrouping,
        definition.ownerDescriptor,
      ],
      boardDefinitionRowSchema,
      options,
    );
    if (row === null) {
      throw new ValidationError('board definition was not created');
    }
    const created = toBoardDefinition(row);
    this.logger.withTraceId(options.traceId).info('board definition created', {
      boardId: created.id,
      orgId: created.orgId,
    });
    return created;
  }

  async updateBoardDefinition(
    boardId: string,
    patch: BoardDefinitionPatch,
    options: CallOptions,
  ): Promise<BoardDefinition> {
    const assignments: string[] = [];
    const params: unknown[] = [boardId];
    for (const [field, column] of Object.entries(BOARD_PATCH_COLUMNS)) {
      const value = patch[field as keyof BoardDefinitionPatch];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    }
    if (assignments.length === 0) {
      const existing = await this.getBoardDefinition(boardId, options);
      if (existing === null) {
        throw new NotFoundError(`board definition ${boardId} does not exist`);
      }
      return existing;
    }
    const row = await this.db.queryOne(
      `UPDATE board_definition
          SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $1
        RETURNING ${BOARD_COLUMNS}`,
      params,
      boardDefinitionRowSchema,
      options,
    );
    if (row === null) {
      throw new NotFoundError(`board definition ${boardId} does not exist`);
    }
    return toBoardDefinition(row);
  }

  async deleteBoardDefinition(
    boardId: string,
    options: CallOptions,
  ): Promise<void> {
    const affected = await this.db.execute(
      `DELETE FROM board_definition WHERE id = $1`,
      [boardId],
      options,
    );
    if (affected === 0) {
      throw new NotFoundError(`board definition ${boardId} does not exist`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sources                                                           */
  /* ---------------------------------------------------------------- */

  async listBoardSources(
    boardId: string,
    options: CallOptions,
  ): Promise<BoardSource[]> {
    const rows = await this.db.query(
      `SELECT ${SOURCE_COLUMNS} FROM board_source
       WHERE board_id = $1
       ORDER BY project_id ASC, team_id ASC, backlog_level ASC`,
      [boardId],
      boardSourceRowSchema,
      options,
    );
    return rows.map(toBoardSource);
  }

  async replaceBoardSources(
    boardId: string,
    sources: readonly BoardSource[],
    options: CallOptions,
  ): Promise<BoardSource[]> {
    const parsed = sources.map((source) => boardSourceSchema.parse(source));
    for (const source of parsed) {
      if (source.boardId !== boardId) {
        throw new ValidationError(
          'every source must belong to the board being replaced',
        );
      }
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM board_source WHERE board_id = $1`,
        [boardId],
        options,
      );
      for (const source of parsed) {
        await tx.execute(
          `INSERT INTO board_source (${SOURCE_COLUMNS})
           VALUES ($1, $2, $3, $4)`,
          [
            source.boardId,
            source.projectId,
            source.teamId,
            source.backlogLevel,
          ],
          options,
        );
      }
      const rows = await tx.query(
        `SELECT ${SOURCE_COLUMNS} FROM board_source
         WHERE board_id = $1
         ORDER BY project_id ASC, team_id ASC, backlog_level ASC`,
        [boardId],
        boardSourceRowSchema,
        options,
      );
      return rows.map(toBoardSource);
    }, options);
  }

  /* ---------------------------------------------------------------- */
  /* Canonical columns                                                 */
  /* ---------------------------------------------------------------- */

  async listCanonicalColumns(
    boardId: string,
    options: CallOptions,
  ): Promise<CanonicalColumn[]> {
    const rows = await this.db.query(
      `SELECT ${CANONICAL_COLUMNS} FROM canonical_column
       WHERE board_id = $1 ORDER BY "order" ASC`,
      [boardId],
      canonicalColumnRowSchema,
      options,
    );
    return rows.map(toCanonicalColumn);
  }

  /**
   * Upserts the given set and removes every column no longer in it.
   * Deleting a column removes the mappings that pointed at it, which is
   * the admin's explicit choice: the cards land in the Unmapped lane
   * rather than being silently moved somewhere plausible.
   */
  async replaceCanonicalColumns(
    boardId: string,
    columns: readonly CanonicalColumn[],
    options: CallOptions,
  ): Promise<CanonicalColumn[]> {
    const parsed = columns.map((column) => canonicalColumnSchema.parse(column));
    assertColumnSetIsCoherent(boardId, parsed);
    const keptIds = parsed.map((column) => column.id);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM canonical_column
          WHERE board_id = $1 AND id <> ALL($2::uuid[])`,
        [boardId, keptIds],
        options,
      );
      for (const column of parsed) {
        await tx.execute(
          `INSERT INTO canonical_column (${CANONICAL_COLUMNS})
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 "order" = EXCLUDED."order",
                 state_category = EXCLUDED.state_category
           WHERE canonical_column.board_id = EXCLUDED.board_id`,
          [
            column.id,
            column.boardId,
            column.name,
            column.order,
            column.stateCategory,
          ],
          options,
        );
      }
      const rows = await tx.query(
        `SELECT ${CANONICAL_COLUMNS} FROM canonical_column
         WHERE board_id = $1 ORDER BY "order" ASC`,
        [boardId],
        canonicalColumnRowSchema,
        options,
      );
      return rows.map(toCanonicalColumn);
    }, options);
  }

  /* ---------------------------------------------------------------- */
  /* Column mappings                                                   */
  /* ---------------------------------------------------------------- */

  async listColumnMappings(
    boardId: string,
    options: CallOptions,
  ): Promise<ColumnMapping[]> {
    const rows = await this.db.query(
      `SELECT ${MAPPING_COLUMNS} FROM column_mapping
       WHERE board_id = $1
       ORDER BY team_id ASC, source_column_id ASC`,
      [boardId],
      columnMappingRowSchema,
      options,
    );
    return rows.map(toColumnMapping);
  }

  async upsertColumnMapping(
    mapping: ColumnMapping,
    options: CallOptions,
  ): Promise<ColumnMapping> {
    const parsed = columnMappingSchema.parse(mapping);
    const row = await this.db.queryOne(
      `INSERT INTO column_mapping (${MAPPING_COLUMNS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (board_id, team_id, source_column_id) DO UPDATE
         SET canonical_column_id = EXCLUDED.canonical_column_id,
             target_state = EXCLUDED.target_state,
             updated_at = now()
       RETURNING ${MAPPING_COLUMNS}`,
      [
        parsed.boardId,
        parsed.teamId,
        parsed.sourceColumnId,
        parsed.canonicalColumnId,
        parsed.targetState,
      ],
      columnMappingRowSchema,
      options,
    );
    if (row === null) {
      throw new ValidationError('column mapping was not written');
    }
    return toColumnMapping(row);
  }

  /** Idempotent: removing a mapping that is already gone is not an error. */
  async deleteColumnMapping(
    boardId: string,
    teamId: string,
    sourceColumnId: string,
    options: CallOptions,
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM column_mapping
        WHERE board_id = $1 AND team_id = $2 AND source_column_id = $3`,
      [boardId, teamId, sourceColumnId],
      options,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Person overrides                                                  */
  /* ---------------------------------------------------------------- */

  async listPersonOverrides(
    boardId: string,
    options: CallOptions,
  ): Promise<PersonOverride[]> {
    const rows = await this.db.query(
      `SELECT ${OVERRIDE_COLUMNS} FROM person_override
       WHERE board_id = $1 ORDER BY descriptor ASC`,
      [boardId],
      personOverrideRowSchema,
      options,
    );
    return rows.map(toPersonOverride);
  }

  async upsertPersonOverride(
    override: PersonOverride,
    options: CallOptions,
  ): Promise<PersonOverride> {
    const parsed = personOverrideSchema.parse(override);
    const row = await this.db.queryOne(
      `INSERT INTO person_override (${OVERRIDE_COLUMNS})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, descriptor) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             hidden = EXCLUDED.hidden,
             updated_at = now()
       RETURNING ${OVERRIDE_COLUMNS}`,
      [parsed.boardId, parsed.descriptor, parsed.displayName, parsed.hidden],
      personOverrideRowSchema,
      options,
    );
    if (row === null) {
      throw new ValidationError('person override was not written');
    }
    return toPersonOverride(row);
  }

  /** Idempotent, like `deleteColumnMapping`. */
  async deletePersonOverride(
    boardId: string,
    descriptor: Descriptor,
    options: CallOptions,
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM person_override WHERE board_id = $1 AND descriptor = $2`,
      [boardId, descriptor],
      options,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Audit                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Appends one write attempt. Called for failures too -- never skipped
   * because the Azure DevOps call did not succeed.
   */
  async appendAudit(
    entry: NewAuditEntry,
    options: CallOptions,
  ): Promise<AuditEntry> {
    const parsed = newAuditEntrySchema.parse(entry);
    const columns = auditResultColumns(parsed.result);
    const row = await this.db.queryOne(
      `INSERT INTO audit_entry
         (board_id, actor, work_item_id, from_column_id, to_column_id,
          outcome, new_rev, state_changed, failure_reason, result,
          occurred_at, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING ${AUDIT_COLUMNS}`,
      [
        parsed.boardId,
        parsed.actor,
        parsed.workItemId,
        parsed.from,
        parsed.to,
        columns.outcome,
        columns.newRev,
        columns.stateChanged,
        columns.failureReason,
        JSON.stringify(parsed.result),
        parsed.timestamp,
        parsed.traceId,
      ],
      auditEntryRowSchema,
      options,
    );
    if (row === null) {
      throw new ValidationError('audit entry was not written');
    }
    const appended = toAuditEntry(row);
    this.logger.withTraceId(options.traceId).info('audit entry appended', {
      boardId: appended.boardId,
      workItemId: appended.workItemId,
      outcome: columns.outcome,
      failureReason: columns.failureReason,
    });
    return appended;
  }

  async listAudit(
    boardId: string,
    query: AuditQuery,
    options: CallOptions,
  ): Promise<AuditEntry[]> {
    const conditions = ['board_id = $1'];
    const params: unknown[] = [boardId];
    const push = (
      fragment: (placeholder: string) => string,
      value: unknown,
    ) => {
      params.push(value);
      conditions.push(fragment(`$${params.length}`));
    };
    if (query.workItemId !== undefined) {
      push((p) => `work_item_id = ${p}`, query.workItemId);
    }
    if (query.actor !== undefined) {
      push((p) => `actor = ${p}`, query.actor);
    }
    if (query.since !== undefined) {
      push((p) => `occurred_at >= ${p}`, query.since);
    }
    if (query.until !== undefined) {
      push((p) => `occurred_at <= ${p}`, query.until);
    }
    params.push(clampLimit(query.limit));
    const rows = await this.db.query(
      `SELECT ${AUDIT_COLUMNS} FROM audit_entry
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
      auditEntryRowSchema,
      options,
    );
    return rows.map(toAuditEntry);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_AUDIT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError('limit must be a positive integer');
  }
  return Math.min(limit, MAX_AUDIT_LIMIT);
}

/**
 * The column set is written as a whole, so it must be internally
 * consistent before it reaches the database: one board, distinct ids,
 * and an `order` that is unique and contiguous from zero.
 */
export function assertColumnSetIsCoherent(
  boardId: string,
  columns: readonly CanonicalColumn[],
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const column of columns) {
    if (column.boardId !== boardId) {
      throw new ValidationError(
        'every canonical column must belong to the board being replaced',
      );
    }
    if (ids.has(column.id)) {
      throw new ValidationError('canonical column ids must be distinct');
    }
    if (orders.has(column.order)) {
      throw new ValidationError('canonical column order must be unique');
    }
    ids.add(column.id);
    orders.add(column.order);
  }
  for (let index = 0; index < columns.length; index += 1) {
    if (!orders.has(index)) {
      throw new ValidationError(
        'canonical column order must be contiguous from zero',
      );
    }
  }
}

export function createConfigStore(db: Database, logger: Logger): ConfigStore {
  return new PostgresConfigStore(db, logger);
}
