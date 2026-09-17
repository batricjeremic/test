/**
 * Validation and the change summary.
 *
 * Saving validates before it writes, and reports what changed rather
 * than saying "saved" and leaving the admin to guess.
 */
import {
  boardDefinitionSchema,
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  personOverrideSchema,
} from '@eg/shared';
import { renumberColumns, sortColumns } from './model';
import type { AdminDraft, AdminValidationIssue } from './types';

/** The draft as it would be written: columns renumbered in render order. */
export function normaliseDraft(draft: AdminDraft): AdminDraft {
  return {
    ...draft,
    definition: { ...draft.definition, name: draft.definition.name.trim() },
    columns: renumberColumns(sortColumns(draft.columns)),
    mappings: draft.mappings.map((mapping) => {
      const targetState = mapping.targetState?.trim() ?? '';
      return targetState === mapping.targetState
        ? mapping
        : { ...mapping, targetState: targetState === '' ? null : targetState };
    }),
  };
}

function duplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

/**
 * Every reason this draft may not be written. An empty array means the
 * save can go ahead; anything else is rendered next to its section and
 * blocks the button.
 */
export function validateDraft(draft: AdminDraft): AdminValidationIssue[] {
  const issues: AdminValidationIssue[] = [];
  const normalised = normaliseDraft(draft);

  if (!boardDefinitionSchema.safeParse(normalised.definition).success) {
    issues.push({
      section: 'definition',
      message: 'The board needs a name before it can be saved.',
    });
  }

  if (normalised.sources.length === 0) {
    issues.push({
      section: 'sources',
      message: 'A board must merge at least one team board.',
    });
  }
  if (
    normalised.sources.some(
      (source) => !boardSourceSchema.safeParse(source).success,
    )
  ) {
    issues.push({
      section: 'sources',
      message: 'Every source needs a project, a team and a backlog level.',
    });
  }
  for (const key of duplicates(
    normalised.sources.map(
      (source) => `${source.projectId}/${source.teamId}/${source.backlogLevel}`,
    ),
  )) {
    issues.push({
      section: 'sources',
      message: `${key} is listed twice as a source.`,
    });
  }

  if (normalised.columns.length === 0) {
    issues.push({
      section: 'columns',
      message: 'A board needs at least one canonical column.',
    });
  }
  if (
    normalised.columns.some(
      (column) => !canonicalColumnSchema.safeParse(column).success,
    )
  ) {
    issues.push({
      section: 'columns',
      message: 'Every canonical column needs a name.',
    });
  }
  for (const name of duplicates(
    normalised.columns.map((column) => column.name.trim().toLowerCase()),
  )) {
    issues.push({
      section: 'columns',
      message: `Two canonical columns are both called "${name}".`,
    });
  }

  const columnIds = new Set(normalised.columns.map((column) => column.id));
  const teamIds = new Set(normalised.sources.map((source) => source.teamId));
  for (const mapping of normalised.mappings) {
    if (!columnMappingSchema.safeParse(mapping).success) {
      issues.push({
        section: 'mappings',
        message: `The mapping for ${mapping.sourceColumnId} is incomplete.`,
      });
      continue;
    }
    if (!columnIds.has(mapping.canonicalColumnId)) {
      issues.push({
        section: 'mappings',
        message: `${mapping.sourceColumnId} maps to a column that no longer exists.`,
      });
    }
    if (!teamIds.has(mapping.teamId)) {
      issues.push({
        section: 'mappings',
        message: `${mapping.teamId} has mappings but is no longer a source.`,
      });
    }
  }
  for (const key of duplicates(
    normalised.mappings.map(
      (mapping) => `${mapping.teamId}/${mapping.sourceColumnId}`,
    ),
  )) {
    issues.push({
      section: 'mappings',
      message: `${key} is mapped twice; a team column maps to one column.`,
    });
  }

  if (
    normalised.overrides.some(
      (override) => !personOverrideSchema.safeParse(override).success,
    )
  ) {
    issues.push({
      section: 'overrides',
      message: 'Every person override needs an identity descriptor.',
    });
  }
  for (const descriptor of duplicates(
    normalised.overrides.map((override) => override.descriptor),
  )) {
    issues.push({
      section: 'overrides',
      message: `${descriptor} has two overrides.`,
    });
  }

  return issues;
}

function sameSet(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Which whole-set PUTs this save actually has to make. */
export function changedSections(
  original: AdminDraft,
  draft: AdminDraft,
): AdminValidationIssue['section'][] {
  const before = normaliseDraft(original);
  const after = normaliseDraft(draft);
  const sections: AdminValidationIssue['section'][] = [];
  if (!sameSet(before.definition, after.definition))
    sections.push('definition');
  if (!sameSet(before.sources, after.sources)) sections.push('sources');
  if (!sameSet(before.columns, after.columns)) sections.push('columns');
  if (!sameSet(before.mappings, after.mappings)) sections.push('mappings');
  if (!sameSet(before.overrides, after.overrides)) sections.push('overrides');
  return sections;
}

/** One human sentence per thing this save changes. */
export function summariseChanges(
  original: AdminDraft,
  draft: AdminDraft,
): string[] {
  const before = normaliseDraft(original);
  const after = normaliseDraft(draft);
  const lines: string[] = [];

  if (before.definition.name !== after.definition.name) {
    lines.push(`Renamed the board to "${after.definition.name}".`);
  }
  if (before.definition.defaultGrouping !== after.definition.defaultGrouping) {
    lines.push(
      `Default grouping is now by ${after.definition.defaultGrouping}.`,
    );
  }

  const sourceKey = (source: { projectId: string; teamId: string }): string =>
    `${source.projectId}/${source.teamId}`;
  const beforeSources = new Set(before.sources.map(sourceKey));
  const afterSources = new Set(after.sources.map(sourceKey));
  const addedSources = [...afterSources].filter(
    (key) => !beforeSources.has(key),
  );
  const removedSources = [...beforeSources].filter(
    (key) => !afterSources.has(key),
  );
  if (addedSources.length > 0) {
    lines.push(`Added ${addedSources.length} source team board.`);
  }
  if (removedSources.length > 0) {
    lines.push(`Removed ${removedSources.length} source team board.`);
  }

  const beforeColumns = new Map(
    before.columns.map((column) => [column.id, column]),
  );
  const afterColumns = new Map(
    after.columns.map((column) => [column.id, column]),
  );
  for (const [id, column] of afterColumns) {
    const was = beforeColumns.get(id);
    if (!was) {
      lines.push(`Added the canonical column "${column.name}".`);
      continue;
    }
    if (was.name !== column.name) {
      lines.push(`Renamed "${was.name}" to "${column.name}".`);
    }
    if (was.stateCategory !== column.stateCategory) {
      lines.push(
        `"${column.name}" is now in the ${column.stateCategory} category.`,
      );
    }
    if (was.order !== column.order) {
      lines.push(`Moved "${column.name}" to position ${column.order + 1}.`);
    }
  }
  for (const [id, column] of beforeColumns) {
    if (!afterColumns.has(id)) {
      lines.push(`Removed the canonical column "${column.name}".`);
    }
  }

  const mappingKey = (mapping: {
    teamId: string;
    sourceColumnId: string;
  }): string => `${mapping.teamId}/${mapping.sourceColumnId}`;
  const beforeMappings = new Map(
    before.mappings.map((mapping) => [mappingKey(mapping), mapping]),
  );
  const afterMappings = new Map(
    after.mappings.map((mapping) => [mappingKey(mapping), mapping]),
  );
  const columnName = (id: string): string => afterColumns.get(id)?.name ?? id;
  for (const [key, mapping] of afterMappings) {
    const was = beforeMappings.get(key);
    if (!was) {
      const target = columnName(mapping.canonicalColumnId);
      lines.push(
        mapping.targetState === null
          ? `Mapped ${mapping.sourceColumnId} to "${target}".`
          : `Mapped ${mapping.sourceColumnId} to "${target}", also writing the state ${mapping.targetState}.`,
      );
      continue;
    }
    if (was.canonicalColumnId !== mapping.canonicalColumnId) {
      lines.push(
        `Remapped ${mapping.sourceColumnId} to "${columnName(
          mapping.canonicalColumnId,
        )}".`,
      );
    }
    if (was.targetState !== mapping.targetState) {
      lines.push(
        mapping.targetState === null
          ? `${mapping.sourceColumnId} no longer writes a state.`
          : `${mapping.sourceColumnId} now also writes the state ${mapping.targetState}.`,
      );
    }
  }
  for (const [key, mapping] of beforeMappings) {
    if (!afterMappings.has(key)) {
      lines.push(`Unmapped ${mapping.sourceColumnId}.`);
    }
  }

  const beforeOverrides = new Map(
    before.overrides.map((override) => [override.descriptor, override]),
  );
  const afterOverrides = new Map(
    after.overrides.map((override) => [override.descriptor, override]),
  );
  for (const [descriptor, override] of afterOverrides) {
    const was = beforeOverrides.get(descriptor);
    if (!was) {
      lines.push('Added a person override.');
    } else if (
      was.displayName !== override.displayName ||
      was.hidden !== override.hidden
    ) {
      lines.push('Updated a person override.');
    }
  }
  for (const [descriptor] of beforeOverrides) {
    if (!afterOverrides.has(descriptor))
      lines.push('Removed a person override.');
  }

  return lines;
}
