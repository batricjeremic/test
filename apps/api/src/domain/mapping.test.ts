import { describe, expect, it } from 'vitest';
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard } from '@eg/shared';
import { kanbanColumnDoneFieldName } from '../ado/types.js';
import {
  buildMappingIndex,
  buildTeamBoardContext,
  canTeamAcceptCanonicalColumn,
  collectUnmappedColumns,
  mappedCanonicalColumnIdsFor,
  mappingMissingFailure,
  normalizeColumnKey,
  resolveCanonicalColumn,
  resolveTeamColumnForCanonical,
} from './mapping.js';
import {
  BOARD_ID,
  makeAdoBoard,
  makeCanonicalColumns,
  makeMapping,
  makeTeam,
} from './test-support.js';

const dev = makeTeam({
  teamId: 'team-dev',
  teamName: 'Dev',
  projectId: 'Delivery',
  adoBoardId: 'ado-dev',
  columns: [
    { name: 'To do', id: 'dev-todo' },
    { name: 'Doing', id: 'dev-doing', isSplit: true },
    { name: 'In review', id: 'dev-review' },
    { name: 'Done', id: 'dev-done' },
  ],
});

const data = makeTeam({
  teamId: 'team-data',
  teamName: 'Data and AI',
  projectId: 'Data',
  adoBoardId: 'ado-data',
  columns: [
    { name: 'New', id: 'data-new' },
    { name: 'Active', id: 'data-active' },
    { name: 'Closed', id: 'data-closed' },
  ],
});

const index = buildMappingIndex({
  boardId: BOARD_ID,
  canonicalColumns: makeCanonicalColumns(),
  mappings: [
    makeMapping('team-dev', 'dev-todo', 'col-todo'),
    makeMapping('team-dev', 'dev-doing', 'col-doing', 'Active'),
    makeMapping('team-dev', 'dev-done', 'col-done', 'Closed'),
    makeMapping('team-data', 'data-new', 'col-todo'),
    makeMapping('team-data', 'data-active', 'col-doing', 'Active'),
  ],
  teams: [dev, data],
});

describe('buildTeamBoardContext', () => {
  it('prefers the board document field names over derived ones', () => {
    const board = makeAdoBoard('ado-dev', ['To do']);
    const context = buildTeamBoardContext({
      source: {
        boardId: BOARD_ID,
        projectId: 'Delivery',
        teamId: 'team-dev',
        backlogLevel: 'Microsoft.RequirementCategory',
      },
      board: {
        ...board,
        fields: {
          columnField: { referenceName: 'WEF_CUSTOM_Kanban.Column' },
          doneField: { referenceName: 'WEF_CUSTOM_Kanban.Column.Done' },
        },
      },
    });
    expect(context.columnFieldName).toBe('WEF_CUSTOM_Kanban.Column');
    expect(context.doneFieldName).toBe('WEF_CUSTOM_Kanban.Column.Done');
  });

  it('derives the WEF field names from the board id otherwise', () => {
    expect(dev.columnFieldName).toBe('WEF_ADODEV_Kanban.Column');
    expect(dev.doneFieldName).toBe(kanbanColumnDoneFieldName('ado-dev'));
  });

  it('keeps the team column order for deterministic tie-breaks', () => {
    expect(dev.columns.map((column) => column.id)).toEqual([
      'dev-todo',
      'dev-doing',
      'dev-review',
      'dev-done',
    ]);
    expect(dev.columns[1]?.isSplit).toBe(true);
  });
});

describe('resolveCanonicalColumn', () => {
  it('resolves a team column onto its canonical column', () => {
    const resolution = resolveCanonicalColumn(index, 'team-dev', 'Doing');
    expect(resolution).toMatchObject({
      kind: 'mapped',
      canonicalColumnId: 'col-doing',
      sourceColumnId: 'dev-doing',
      sourceColumnName: 'Doing',
      targetState: 'Active',
      isSplit: true,
    });
  });

  it('matches the column name case- and whitespace-insensitively', () => {
    expect(
      resolveCanonicalColumn(index, 'team-dev', '  doing  '),
    ).toMatchObject({ kind: 'mapped', canonicalColumnId: 'col-doing' });
    expect(normalizeColumnKey(' In Review ')).toBe('in review');
  });

  it('resolves a value written as the column id too', () => {
    expect(resolveCanonicalColumn(index, 'team-dev', 'dev-todo')).toMatchObject(
      { kind: 'mapped', canonicalColumnId: 'col-todo' },
    );
  });

  it('never guesses: a column with no mapping row is unmapped', () => {
    expect(resolveCanonicalColumn(index, 'team-dev', 'In review')).toEqual({
      kind: 'unmapped',
      canonicalColumnId: UNMAPPED_COLUMN_ID,
      sourceColumnName: 'In review',
      reason: 'no-mapping-row',
    });
  });

  it.each([
    ['team-ghost', 'Doing', 'unknown-team'],
    ['team-dev', null, 'missing-column-value'],
    ['team-dev', '   ', 'missing-column-value'],
    ['team-dev', 'Elsewhere', 'unknown-column'],
  ])('reports %s / %s as %s', (teamId, value, reason) => {
    const resolution = resolveCanonicalColumn(index, teamId, value);
    expect(resolution.kind).toBe('unmapped');
    expect(resolution.canonicalColumnId).toBe(UNMAPPED_COLUMN_ID);
    if (resolution.kind === 'unmapped') expect(resolution.reason).toBe(reason);
  });

  it('drops a mapping row pointing at a column this board never declared', () => {
    const broken = buildMappingIndex({
      boardId: BOARD_ID,
      canonicalColumns: makeCanonicalColumns(),
      mappings: [makeMapping('team-dev', 'dev-todo', 'col-ghost')],
      teams: [dev],
    });
    expect(resolveCanonicalColumn(broken, 'team-dev', 'To do')).toMatchObject({
      kind: 'unmapped',
      reason: 'no-mapping-row',
    });
  });

  it('ignores mapping rows belonging to another board', () => {
    const other = buildMappingIndex({
      boardId: BOARD_ID,
      canonicalColumns: makeCanonicalColumns(),
      mappings: [
        {
          ...makeMapping('team-dev', 'dev-todo', 'col-todo'),
          boardId: 'other',
        },
      ],
      teams: [dev],
    });
    expect(resolveCanonicalColumn(other, 'team-dev', 'To do')).toMatchObject({
      kind: 'unmapped',
      reason: 'no-mapping-row',
    });
  });
});

describe('resolveTeamColumnForCanonical', () => {
  it('resolves the write target, its state and the split companion', () => {
    expect(
      resolveTeamColumnForCanonical(index, 'team-dev', 'col-doing'),
    ).toEqual({
      kind: 'mapped',
      teamId: 'team-dev',
      canonicalColumnId: 'col-doing',
      sourceColumnId: 'dev-doing',
      sourceColumnName: 'Doing',
      targetState: 'Active',
      isSplit: true,
      adoBoardId: 'ado-dev',
      columnFieldName: 'WEF_ADODEV_Kanban.Column',
      doneFieldName: kanbanColumnDoneFieldName('ado-dev'),
      done: false,
    });
  });

  it('carries a null targetState when only the column moves', () => {
    const resolution = resolveTeamColumnForCanonical(
      index,
      'team-dev',
      'col-todo',
    );
    expect(resolution).toMatchObject({
      kind: 'mapped',
      targetState: null,
      isSplit: false,
      doneFieldName: null,
      done: null,
    });
  });

  it('refuses a canonical column this team has no mapping for', () => {
    const resolution = resolveTeamColumnForCanonical(
      index,
      'team-data',
      'col-done',
    );
    expect(resolution.kind).toBe('refused');
    if (resolution.kind !== 'refused') return;
    expect(resolution.reason).toBe('no-mapping-row');
    expect(resolution.failure).toEqual({
      reason: 'mapping-missing',
      message:
        'Data and AI has no column mapped to "Done". Ask an admin to map it before moving cards there.',
      projectId: 'Data',
      teamId: 'team-data',
      teamName: 'Data and AI',
      canonicalColumnId: 'col-done',
      canonicalColumnName: 'Done',
    });
  });

  it.each([
    ['team-ghost', 'col-done', 'unknown-team'],
    ['team-dev', 'col-ghost', 'unknown-canonical-column'],
  ])('refuses %s / %s as %s', (teamId, columnId, reason) => {
    const resolution = resolveTeamColumnForCanonical(index, teamId, columnId);
    expect(resolution.kind).toBe('refused');
    if (resolution.kind === 'refused') expect(resolution.reason).toBe(reason);
  });

  it('picks the first source column in board order when two map alike', () => {
    const ambiguous = buildMappingIndex({
      boardId: BOARD_ID,
      canonicalColumns: makeCanonicalColumns(),
      mappings: [
        makeMapping('team-dev', 'dev-review', 'col-doing'),
        makeMapping('team-dev', 'dev-doing', 'col-doing'),
      ],
      teams: [dev],
    });
    expect(
      resolveTeamColumnForCanonical(ambiguous, 'team-dev', 'col-doing'),
    ).toMatchObject({ sourceColumnId: 'dev-doing' });
  });
});

describe('drop targets', () => {
  it('lists the mapped canonical columns in board order', () => {
    expect(mappedCanonicalColumnIdsFor(index, 'team-dev')).toEqual([
      'col-todo',
      'col-doing',
      'col-done',
    ]);
    expect(mappedCanonicalColumnIdsFor(index, 'team-data')).toEqual([
      'col-todo',
      'col-doing',
    ]);
    expect(mappedCanonicalColumnIdsFor(index, 'team-ghost')).toEqual([]);
  });

  it('refuses the drop before the drag starts', () => {
    expect(canTeamAcceptCanonicalColumn(index, 'team-data', 'col-doing')).toBe(
      true,
    );
    expect(canTeamAcceptCanonicalColumn(index, 'team-data', 'col-done')).toBe(
      false,
    );
    expect(
      canTeamAcceptCanonicalColumn(index, 'team-dev', UNMAPPED_COLUMN_ID),
    ).toBe(false);
    expect(canTeamAcceptCanonicalColumn(index, 'team-ghost', 'col-todo')).toBe(
      false,
    );
  });

  it('names the team and column even when the team is unknown', () => {
    const failure = mappingMissingFailure(index, 'team-ghost', 'col-done');
    expect(failure.teamName).toBe('');
    expect(failure.message).toContain('team-ghost');
    expect(failure.canonicalColumnName).toBe('Done');
  });
});

describe('collectUnmappedColumns', () => {
  const card = (overrides: Partial<BoardCard>): BoardCard => ({
    workItemId: 1,
    project: 'Delivery',
    teamId: 'team-dev',
    iterationId: 'it-1',
    title: 'Card',
    type: 'Task',
    assignedTo: null,
    state: 'Active',
    sourceColumn: 'In review',
    canonicalColumnId: UNMAPPED_COLUMN_ID,
    remainingWork: null,
    tags: [],
    rev: 1,
    ...overrides,
  });

  it('counts stranded cards per team and column, and names both', () => {
    const refs = collectUnmappedColumns(
      [
        card({ workItemId: 1 }),
        card({ workItemId: 2, sourceColumn: 'in review' }),
        card({
          workItemId: 3,
          teamId: 'team-data',
          project: 'Data',
          sourceColumn: 'Closed',
        }),
        card({ workItemId: 4, canonicalColumnId: 'col-todo' }),
      ],
      index,
    );
    expect(refs).toEqual([
      {
        projectId: 'Data',
        teamId: 'team-data',
        teamName: 'Data and AI',
        sourceColumn: 'Closed',
        cardCount: 1,
      },
      {
        projectId: 'Delivery',
        teamId: 'team-dev',
        teamName: 'Dev',
        sourceColumn: 'In review',
        cardCount: 2,
      },
    ]);
  });

  it('is empty when every card resolved', () => {
    expect(
      collectUnmappedColumns([card({ canonicalColumnId: 'col-todo' })], index),
    ).toEqual([]);
  });
});
