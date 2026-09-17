import { describe, expect, it } from 'vitest';
import {
  dateWindowSchema,
  DEFAULT_ITERATION_ALIGNMENT,
  ITERATION_ALIGNMENT_MODES,
  iterationAlignmentSchema,
  teamIterationWindowSchema,
} from './iteration.js';

describe('iterationAlignmentSchema', () => {
  it('exposes exactly the three modes the spec lists', () => {
    expect([...ITERATION_ALIGNMENT_MODES]).toEqual([
      'each-team-current',
      'date-window',
      'named-iteration',
    ]);
  });

  it('round-trips each-team-current, the default', () => {
    expect(iterationAlignmentSchema.parse(DEFAULT_ITERATION_ALIGNMENT)).toEqual(
      { mode: 'each-team-current' },
    );
  });

  it('round-trips a date window', () => {
    const alignment = {
      mode: 'date-window' as const,
      window: { start: '2026-09-01', end: '2026-09-30' },
    };
    expect(iterationAlignmentSchema.parse(alignment)).toEqual(alignment);
  });

  it('round-trips a named iteration', () => {
    const alignment = {
      mode: 'named-iteration' as const,
      iterationPath: 'Delivery\\Sprint 24',
    };
    expect(iterationAlignmentSchema.parse(alignment)).toEqual(alignment);
  });

  it('rejects a date-window without its window parameter', () => {
    const result = iterationAlignmentSchema.safeParse({ mode: 'date-window' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    const result = iterationAlignmentSchema.safeParse({ mode: 'quarter' });
    expect(result.success).toBe(false);
  });
});

describe('dateWindowSchema', () => {
  it('rejects a window that ends before it starts', () => {
    const result = dateWindowSchema.safeParse({
      start: '2026-09-30',
      end: '2026-09-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an instant where a calendar date is required', () => {
    const result = dateWindowSchema.safeParse({
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-30',
    });
    expect(result.success).toBe(false);
  });
});

describe('teamIterationWindowSchema', () => {
  const window = {
    projectId: 'proj-1',
    projectName: 'Delivery',
    teamId: 'team-dev',
    teamName: 'Dev',
    iterationId: 'iter-24',
    iterationPath: 'Delivery\\Sprint 24',
    iterationName: 'Sprint 24',
    startDate: '2026-09-14T00:00:00Z',
    finishDate: '2026-10-02T00:00:00Z',
    workingDaysTotal: 15,
    workingDaysElapsed: 2,
  };

  it('round-trips a dated iteration', () => {
    expect(teamIterationWindowSchema.parse(window)).toEqual(window);
  });

  it('round-trips an iteration with no dates set', () => {
    const undated = { ...window, startDate: null, finishDate: null };
    expect(teamIterationWindowSchema.parse(undated)).toEqual(undated);
  });

  it('rejects a negative elapsed day count', () => {
    const result = teamIterationWindowSchema.safeParse({
      ...window,
      workingDaysElapsed: -1,
    });
    expect(result.success).toBe(false);
  });
});
