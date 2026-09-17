import { describe, expect, it } from 'vitest';
import { makeAdminDraft, makeAdminSnapshot } from './adminFixtures';
import {
  buildAdminTeams,
  moveColumn,
  namingFromSnapshot,
  setMapping,
  unmappedTeamColumns,
} from './model';
import { changedSections, summariseChanges, validateDraft } from './validation';

describe('validateDraft', () => {
  it('accepts the fixture board', () => {
    expect(validateDraft(makeAdminDraft())).toEqual([]);
  });

  it('refuses a board with no sources', () => {
    const issues = validateDraft(makeAdminDraft({ sources: [] }));
    expect(issues.map((issue) => issue.section)).toContain('sources');
  });

  it('refuses two canonical columns with the same name', () => {
    const draft = makeAdminDraft();
    const first = draft.columns[0];
    const second = draft.columns[1];
    if (!first || !second) throw new Error('fixture has too few columns');
    const issues = validateDraft({
      ...draft,
      columns: [first, { ...second, name: first.name }],
    });
    expect(issues.map((issue) => issue.message)).toContain(
      `Two canonical columns are both called "${first.name.toLowerCase()}".`,
    );
  });

  it('refuses a mapping onto a column that was deleted', () => {
    const draft = makeAdminDraft();
    const issues = validateDraft({
      ...draft,
      columns: draft.columns.filter((column) => column.id !== 'col-doing'),
    });
    expect(
      issues.some((issue) => issue.message.includes('no longer exists')),
    ).toBe(true);
  });
});

describe('summariseChanges', () => {
  it('names a reorder and writes only the sections that changed', () => {
    const original = makeAdminDraft();
    const draft = {
      ...original,
      columns: moveColumn(original.columns, 'col-review', -1),
    };
    expect(changedSections(original, draft)).toEqual(['columns']);
    expect(summariseChanges(original, draft)).toContain(
      'Moved "In review" to position 2.',
    );
  });

  it('is empty when nothing moved', () => {
    const draft = makeAdminDraft();
    expect(changedSections(draft, draft)).toEqual([]);
    expect(summariseChanges(draft, draft)).toEqual([]);
  });
});

describe('unmappedTeamColumns', () => {
  it('counts a team column with no mapping row, and stops once mapped', () => {
    const snapshot = makeAdminSnapshot();
    const draft = makeAdminDraft();
    const teams = buildAdminTeams(
      draft.sources,
      draft.mappings,
      snapshot.unmappedColumns,
      namingFromSnapshot(snapshot),
    );
    const before = unmappedTeamColumns(teams, draft.mappings);
    expect(before).toHaveLength(1);
    expect(before[0]?.sourceColumnId).toBe('In Review');
    expect(before[0]?.cardCount).toBe(3);

    const mappings = setMapping(
      draft.mappings,
      draft.definition.id,
      'team-data',
      'In Review',
      'col-review',
    );
    expect(unmappedTeamColumns(teams, mappings)).toEqual([]);
  });
});
