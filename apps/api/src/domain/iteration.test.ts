import { describe, expect, it } from 'vitest';
import type { IterationAlignment } from '@eg/shared';
import { DEFAULT_ITERATION_ALIGNMENT } from '@eg/shared';
import {
  inScopeIterationIds,
  normalizeIterationPath,
  resolveBurndownAvailability,
  resolveTeamIterationScope,
  resolveTeamIterationScopes,
} from './iteration.js';
import type { Weekday } from './working-days.js';
import { fixedClock, makeIteration, makeTeam } from './test-support.js';

/** Thursday of the first week of a 14 September sprint. */
const NOW = '2026-09-17T09:00:00.000Z';
const clock = fixedClock(NOW);

const dev = makeTeam({ teamId: 'team-dev', teamName: 'Dev' });
const data = makeTeam({
  teamId: 'team-data',
  teamName: 'Data and AI',
  projectId: 'Data',
});

const sprint24 = makeIteration({
  id: 'it-dev-24',
  name: 'Sprint 24',
  path: 'Delivery\\Sprint 24',
  start: '2026-09-14T00:00:00Z',
  finish: '2026-09-25T00:00:00Z',
  timeFrame: 'current',
});

const sprint25 = makeIteration({
  id: 'it-dev-25',
  name: 'Sprint 25',
  path: 'Delivery\\Sprint 25',
  start: '2026-09-28T00:00:00Z',
  finish: '2026-10-09T00:00:00Z',
  timeFrame: 'future',
});

/** A ten-day sprint that started a week earlier, so windows mismatch. */
const dataSprint = makeIteration({
  id: 'it-data-12',
  name: 'Iteration 12',
  path: 'Data\\Iteration 12',
  start: '2026-09-07T00:00:00Z',
  finish: '2026-09-18T00:00:00Z',
  timeFrame: 'current',
});

const FOUR_DAY: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
];

describe('each-team-current', () => {
  it('takes the iteration the service marks current', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint25, sprint24] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window.iterationId).toBe('it-dev-24');
    expect(scope.iterations).toHaveLength(1);
  });

  it('carries the sprint dates and says which day of how many it is', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window).toEqual({
      projectId: 'Delivery',
      projectName: 'Delivery',
      teamId: 'team-dev',
      teamName: 'Dev',
      iterationId: 'it-dev-24',
      iterationPath: 'Delivery\\Sprint 24',
      iterationName: 'Sprint 24',
      startDate: '2026-09-14T00:00:00.000Z',
      finishDate: '2026-09-25T00:00:00.000Z',
      workingDaysTotal: 10,
      workingDaysElapsed: 4,
    });
  });

  it('uses the team’s own working-days setting', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24], workingDays: FOUR_DAY },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window.workingDaysTotal).toBe(8);
    expect(scope.primary?.window.workingDaysElapsed).toBe(4);
  });

  it('falls back to the iteration containing today when none is marked', () => {
    const unmarked = makeIteration({
      id: 'it-x',
      start: '2026-09-14T00:00:00Z',
      finish: '2026-09-25T00:00:00Z',
    });
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [unmarked] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window.iterationId).toBe('it-x');
  });

  it('puts nothing in scope when the team has no current sprint', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint25] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary).toBeNull();
    expect(scope.iterations).toEqual([]);
  });

  it('never reports more elapsed days than the sprint has', () => {
    const past = makeIteration({
      id: 'it-past',
      start: '2026-08-03T00:00:00Z',
      finish: '2026-08-14T00:00:00Z',
      timeFrame: 'current',
    });
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [past] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window.workingDaysElapsed).toBe(10);
    expect(scope.primary?.window.workingDaysTotal).toBe(10);
  });

  it('reports no elapsed days before a sprint starts', () => {
    const future = makeIteration({
      id: 'it-future',
      start: '2026-09-28T00:00:00Z',
      finish: '2026-10-09T00:00:00Z',
      timeFrame: 'current',
    });
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [future] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window.workingDaysElapsed).toBe(0);
  });

  it('handles an iteration with no dates at all', () => {
    const undated = makeIteration({ id: 'it-undated', timeFrame: 'current' });
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [undated] },
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scope.primary?.window).toMatchObject({
      startDate: null,
      finishDate: null,
      workingDaysTotal: 0,
      workingDaysElapsed: 0,
    });
  });
});

describe('date-window', () => {
  const alignment = (start: string, end: string): IterationAlignment => ({
    mode: 'date-window',
    window: { start, end },
  });

  it('takes every iteration overlapping the range', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24, sprint25] },
      alignment('2026-09-20', '2026-10-01'),
      clock,
    );
    expect(scope.iterations.map((entry) => entry.window.iterationId)).toEqual([
      'it-dev-24',
      'it-dev-25',
    ]);
    expect(scope.primary?.window.iterationId).toBe('it-dev-24');
    expect([...inScopeIterationIds(scope)]).toEqual(['it-dev-24', 'it-dev-25']);
  });

  it('counts a touching boundary as an overlap', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24] },
      alignment('2026-09-25', '2026-09-27'),
      clock,
    );
    expect(scope.iterations).toHaveLength(1);
  });

  it('excludes an iteration outside the range', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24] },
      alignment('2026-10-01', '2026-10-31'),
      clock,
    );
    expect(scope.iterations).toEqual([]);
  });

  it('excludes an iteration with no dates: it cannot be known to overlap', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [makeIteration({ id: 'it-undated' })] },
      alignment('2026-09-01', '2026-09-30'),
      clock,
    );
    expect(scope.iterations).toEqual([]);
  });

  it('is empty when the window itself is unparsable', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24] },
      alignment('not-a-date', 'worse'),
      clock,
    );
    expect(scope.iterations).toEqual([]);
  });
});

describe('named-iteration', () => {
  const alignment = (iterationPath: string): IterationAlignment => ({
    mode: 'named-iteration',
    iterationPath,
  });

  it('matches on the iteration path', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24, sprint25] },
      alignment('Delivery\\Sprint 25'),
      clock,
    );
    expect(scope.primary?.window.iterationId).toBe('it-dev-25');
  });

  it('ignores slash direction and case', () => {
    const scope = resolveTeamIterationScope(
      { team: dev, iterations: [sprint24] },
      alignment('delivery/sprint 24'),
      clock,
    );
    expect(scope.primary?.window.iterationId).toBe('it-dev-24');
    expect(normalizeIterationPath('\\Delivery\\\\Sprint 24\\')).toBe(
      'delivery\\sprint 24',
    );
  });

  it('falls back to the iteration name for teams that spell paths apart', () => {
    const scope = resolveTeamIterationScope(
      { team: data, iterations: [dataSprint] },
      alignment('Iteration 12'),
      clock,
    );
    expect(scope.primary?.window.iterationId).toBe('it-data-12');
  });

  it('puts nothing in scope for a team that does not have it', () => {
    const scope = resolveTeamIterationScope(
      { team: data, iterations: [dataSprint] },
      alignment('Delivery\\Sprint 24'),
      clock,
    );
    expect(scope.primary).toBeNull();
  });
});

describe('resolveBurndownAvailability', () => {
  it('suppresses burndown when windows differ, because it would be a lie', () => {
    const scopes = resolveTeamIterationScopes(
      [
        { team: dev, iterations: [sprint24] },
        { team: data, iterations: [dataSprint] },
      ],
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(scopes[0]?.primary?.window.workingDaysElapsed).toBe(4);
    expect(scopes[1]?.primary?.window.workingDaysElapsed).toBe(9);
    expect(resolveBurndownAvailability(scopes)).toBe(
      'suppressed-mismatched-windows',
    );
  });

  it('allows burndown when every team is in the same window', () => {
    const aligned = makeIteration({
      id: 'it-data-aligned',
      name: 'Sprint 24',
      path: 'Data\\Sprint 24',
      start: '2026-09-14T00:00:00Z',
      finish: '2026-09-25T00:00:00Z',
      timeFrame: 'current',
    });
    const scopes = resolveTeamIterationScopes(
      [
        { team: dev, iterations: [sprint24] },
        { team: data, iterations: [aligned] },
      ],
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(resolveBurndownAvailability(scopes)).toBe('available');
  });

  it('suppresses burndown in a date window spanning two iterations', () => {
    const scopes = resolveTeamIterationScopes(
      [{ team: dev, iterations: [sprint24, sprint25] }],
      {
        mode: 'date-window',
        window: { start: '2026-09-20', end: '2026-10-01' },
      },
      clock,
    );
    expect(resolveBurndownAvailability(scopes)).toBe(
      'suppressed-mismatched-windows',
    );
  });

  it.each([['no team resolved an iteration', [] as const]])(
    'suppresses burndown when %s',
    (_label, scopes) => {
      expect(resolveBurndownAvailability([...scopes])).toBe(
        'suppressed-mismatched-windows',
      );
    },
  );

  it('suppresses burndown when the shared iteration has no dates', () => {
    const undated = makeIteration({ id: 'it-undated', timeFrame: 'current' });
    const scopes = resolveTeamIterationScopes(
      [{ team: dev, iterations: [undated] }],
      DEFAULT_ITERATION_ALIGNMENT,
      clock,
    );
    expect(resolveBurndownAvailability(scopes)).toBe(
      'suppressed-mismatched-windows',
    );
  });
});
