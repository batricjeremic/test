/**
 * Row shapes as Postgres returns them, and the mapping onto the
 * `@eg/shared` DTOs. Every mapper validates on the way out, so a column
 * renamed in a later migration fails loudly instead of leaking a
 * half-shaped object into a board snapshot.
 */
import { z } from 'zod';
import {
  auditEntrySchema,
  auditResultSchema,
  boardDefinitionSchema,
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  personOverrideSchema,
  type AuditEntry,
  type AuditResult,
  type BoardDefinition,
  type BoardSource,
  type CanonicalColumn,
  type ColumnMapping,
  type PersonOverride,
} from '@eg/shared';
import { InternalError } from '../errors.js';

/**
 * `timestamptz` arrives as a `Date` from node-postgres, but a fake or a
 * different parser may hand back the ISO string. Both normalise to an
 * ISO instant with an offset, which is what `isoTimestampSchema` wants.
 */
export const timestampColumnSchema = z
  .union([z.date(), z.string()])
  .transform((value, ctx): string => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not a timestamp',
      });
      return z.NEVER;
    }
    return date.toISOString();
  });

/** `bigint` and `integer` both arrive as strings under some drivers. */
export const numericColumnSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a number' });
      return z.NEVER;
    }
    return parsed;
  });

const parseDto = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InternalError(`stored ${what} is not a valid ${what}`, {
      cause: parsed.error,
      details: { entity: what },
    });
  }
  return parsed.data;
};

/* ------------------------------------------------------------------ */
/* board_definition                                                    */
/* ------------------------------------------------------------------ */

export const boardDefinitionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_id: z.string(),
  default_grouping: z.string(),
  owner_descriptor: z.string(),
});
export type BoardDefinitionRow = z.infer<typeof boardDefinitionRowSchema>;

export function toBoardDefinition(row: BoardDefinitionRow): BoardDefinition {
  return parseDto(
    boardDefinitionSchema,
    {
      id: row.id,
      name: row.name,
      orgId: row.org_id,
      defaultGrouping: row.default_grouping,
      ownerDescriptor: row.owner_descriptor,
    },
    'board definition',
  );
}

/* ------------------------------------------------------------------ */
/* board_source                                                        */
/* ------------------------------------------------------------------ */

export const boardSourceRowSchema = z.object({
  board_id: z.string(),
  project_id: z.string(),
  team_id: z.string(),
  backlog_level: z.string(),
});
export type BoardSourceRow = z.infer<typeof boardSourceRowSchema>;

export function toBoardSource(row: BoardSourceRow): BoardSource {
  return parseDto(
    boardSourceSchema,
    {
      boardId: row.board_id,
      projectId: row.project_id,
      teamId: row.team_id,
      backlogLevel: row.backlog_level,
    },
    'board source',
  );
}

/* ------------------------------------------------------------------ */
/* canonical_column                                                    */
/* ------------------------------------------------------------------ */

export const canonicalColumnRowSchema = z.object({
  id: z.string(),
  board_id: z.string(),
  name: z.string(),
  order: numericColumnSchema,
  state_category: z.string(),
});
export type CanonicalColumnRow = z.infer<typeof canonicalColumnRowSchema>;

export function toCanonicalColumn(row: CanonicalColumnRow): CanonicalColumn {
  return parseDto(
    canonicalColumnSchema,
    {
      id: row.id,
      boardId: row.board_id,
      name: row.name,
      order: row.order,
      stateCategory: row.state_category,
    },
    'canonical column',
  );
}

/* ------------------------------------------------------------------ */
/* column_mapping                                                      */
/* ------------------------------------------------------------------ */

export const columnMappingRowSchema = z.object({
  board_id: z.string(),
  team_id: z.string(),
  source_column_id: z.string(),
  canonical_column_id: z.string(),
  target_state: z.string().nullable(),
});
export type ColumnMappingRow = z.infer<typeof columnMappingRowSchema>;

export function toColumnMapping(row: ColumnMappingRow): ColumnMapping {
  return parseDto(
    columnMappingSchema,
    {
      boardId: row.board_id,
      teamId: row.team_id,
      sourceColumnId: row.source_column_id,
      canonicalColumnId: row.canonical_column_id,
      targetState: row.target_state,
    },
    'column mapping',
  );
}

/* ------------------------------------------------------------------ */
/* person_override                                                     */
/* ------------------------------------------------------------------ */

export const personOverrideRowSchema = z.object({
  board_id: z.string(),
  descriptor: z.string(),
  display_name: z.string(),
  hidden: z.boolean(),
});
export type PersonOverrideRow = z.infer<typeof personOverrideRowSchema>;

export function toPersonOverride(row: PersonOverrideRow): PersonOverride {
  return parseDto(
    personOverrideSchema,
    {
      boardId: row.board_id,
      descriptor: row.descriptor,
      displayName: row.display_name,
      hidden: row.hidden,
    },
    'person override',
  );
}

/* ------------------------------------------------------------------ */
/* audit_entry                                                         */
/* ------------------------------------------------------------------ */

export const auditEntryRowSchema = z.object({
  id: z.string(),
  board_id: z.string(),
  actor: z.string(),
  work_item_id: numericColumnSchema,
  from_column_id: z.string(),
  to_column_id: z.string(),
  result: z.unknown(),
  occurred_at: timestampColumnSchema,
  trace_id: z.string(),
});
export type AuditEntryRow = z.infer<typeof auditEntryRowSchema>;

export function toAuditEntry(row: AuditEntryRow): AuditEntry {
  return parseDto(
    auditEntrySchema,
    {
      id: row.id,
      boardId: row.board_id,
      actor: row.actor,
      workItemId: row.work_item_id,
      from: row.from_column_id,
      to: row.to_column_id,
      result: row.result,
      timestamp: row.occurred_at,
      traceId: row.trace_id,
    },
    'audit entry',
  );
}

/**
 * The denormalised columns the audit table keeps beside the JSON, so
 * support can filter on outcome without opening every payload.
 */
export interface AuditResultColumns {
  readonly outcome: 'success' | 'failure';
  readonly newRev: number | null;
  readonly stateChanged: boolean | null;
  readonly failureReason: string | null;
}

export function auditResultColumns(result: AuditResult): AuditResultColumns {
  const parsed = parseDto(auditResultSchema, result, 'audit result');
  if (parsed.outcome === 'success') {
    return {
      outcome: 'success',
      newRev: parsed.newRev,
      stateChanged: parsed.stateChanged,
      failureReason: null,
    };
  }
  return {
    outcome: 'failure',
    newRev: null,
    stateChanged: null,
    failureReason: parsed.failure.reason,
  };
}
