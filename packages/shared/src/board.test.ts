import { describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  boardDefinitionSchema,
  boardSourceSchema,
  canonicalColumnSchema,
  columnMappingSchema,
  personOverrideSchema,
  stateCategorySchema,
  unmappedColumnRefSchema,
  UNASSIGNED_LANE_ID,
  UNMAPPED_COLUMN_ID,
} from './board.js';
import {
  boardFilterSetSchema,
  EMPTY_BOARD_FILTER_SET,
} from './filters.js';

const card = {
  workItemId: 4211,
  project: 'Delivery',
  teamId: 'team-dev',
  iterationId: 'iter-24',
  title: 'Wire the aggregated board',
  type: 'User Story',
  assignedTo: { descriptor: 'aad.YWJj', displayName: 'A. Person' },
  state: 'Active',
  sourceColumn: 'In Review',
  canonicalColumnId: 'col-review',
  remainingWork: 4.5,
  tags: ['ui', 'sprint-goal'],
  rev: 7,
};

describe('boardCardSchema', () => {
  it('round-trips a card with every field populated', () => {
    expect(boardCardSchema.parse(card)).toEqual(card);
  });

  it('round-trips the unassigned, unestimated, unmapped card', () => {
    const sparse = {
      ...card,
      assignedTo: null,
      remainingWork: null,
      canonicalColumnId: UNMAPPED_COLUMN_ID,
      tags: [],
    };
    expect(boardCardSchema.parse(sparse)).toEqual(sparse);
  });

  it('rejects a card without a rev, because writes need one', () => {
    const { rev: _rev, ...withoutRev } = card;
    const result = boardCardSchema.safeParse(withoutRev);
    expect(result.success).toBe(false);
  });

  it('rejects an assignedTo missing its descriptor', () => {
    const result = boardCardSchema.safeParse({
      ...card,
      assignedTo: { displayName: 'A. Person' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a remainingWork of undefined rather than null', () => {
    const result = boardCardSchema.safeParse({
      ...card,
      remainingWork: undefined,
    });
    expect(result.success).toBe(false);
  });
});

describe('configuration entities', () => {
  it('round-trips a board definition', () => {
    const definition = {
      id: 'board-1',
      name: 'Delivery — all divisions',
      orgId: 'expertgroup',
      defaultGrouping: 'person' as const,
      ownerDescriptor: 'aad.b3du',
    };
    expect(boardDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it('rejects a grouping that is not person or team', () => {
    const result = boardDefinitionSchema.safeParse({
      id: 'board-1',
      name: 'Delivery',
      orgId: 'expertgroup',
      defaultGrouping: 'project',
      ownerDescriptor: 'aad.b3du',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a board source', () => {
    const source = {
      boardId: 'board-1',
      projectId: 'proj-1',
      teamId: 'team-dev',
      backlogLevel: 'Microsoft.RequirementCategory',
    };
    expect(boardSourceSchema.parse(source)).toEqual(source);
  });

  it('accepts the three state categories and nothing else', () => {
    expect(stateCategorySchema.parse('Proposed')).toBe('Proposed');
    expect(stateCategorySchema.parse('InProgress')).toBe('InProgress');
    expect(stateCategorySchema.parse('Completed')).toBe('Completed');
    expect(stateCategorySchema.safeParse('Done').success).toBe(false);
  });

  it('round-trips a canonical column', () => {
    const column = {
      id: 'col-review',
      boardId: 'board-1',
      name: 'In Review',
      order: 2,
      stateCategory: 'InProgress' as const,
    };
    expect(canonicalColumnSchema.parse(column)).toEqual(column);
  });

  it('round-trips a mapping with and without a target state', () => {
    const mapped = {
      boardId: 'board-1',
      teamId: 'team-dev',
      sourceColumnId: 'src-3',
      canonicalColumnId: 'col-review',
      targetState: 'Active',
    };
    expect(columnMappingSchema.parse(mapped)).toEqual(mapped);
    const columnOnly = { ...mapped, targetState: null };
    expect(columnMappingSchema.parse(columnOnly)).toEqual(columnOnly);
  });

  it('rejects a mapping whose targetState is omitted', () => {
    const result = columnMappingSchema.safeParse({
      boardId: 'board-1',
      teamId: 'team-dev',
      sourceColumnId: 'src-3',
      canonicalColumnId: 'col-review',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a person override', () => {
    const override = {
      boardId: 'board-1',
      descriptor: 'aad.Y29u',
      displayName: 'Contractor (Data)',
      hidden: false,
    };
    expect(personOverrideSchema.parse(override)).toEqual(override);
  });

  it('round-trips an unmapped column report', () => {
    const report = {
      projectId: 'proj-1',
      teamId: 'team-data',
      teamName: 'Data and AI',
      sourceColumn: 'Blocked',
      cardCount: 3,
    };
    expect(unmappedColumnRefSchema.parse(report)).toEqual(report);
  });

  it('keeps the reserved lane ids distinct', () => {
    expect(UNMAPPED_COLUMN_ID).not.toBe(UNASSIGNED_LANE_ID);
  });
});

describe('boardFilterSetSchema', () => {
  it('defaults every filter to unrestricted', () => {
    expect(boardFilterSetSchema.parse({})).toEqual(EMPTY_BOARD_FILTER_SET);
  });

  it('round-trips a fully populated filter set', () => {
    const filters = {
      projectIds: ['proj-1'],
      teamIds: ['team-dev'],
      workItemTypes: ['Bug'],
      tags: ['sprint-goal'],
      states: ['Active'],
      unassignedOnly: true,
    };
    expect(boardFilterSetSchema.parse(filters)).toEqual(filters);
  });

  it('rejects an empty string in a filter list', () => {
    const result = boardFilterSetSchema.safeParse({ projectIds: [''] });
    expect(result.success).toBe(false);
  });
});
