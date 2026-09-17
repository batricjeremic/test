import { describe, expect, it } from 'vitest';
import { makePersonLoad } from '../api/fixtures';
import {
  countPeopleWithOutOfScopeTeams,
  deriveCapacityFigures,
  findPersonLoad,
  formatHours,
  sortPeopleByLoad,
} from './load';

describe('deriveCapacityFigures', () => {
  it('fills the track and flags a person over capacity', () => {
    const figures = deriveCapacityFigures(
      makePersonLoad({ capacityHours: 40, committedHours: 60, load: 1.5 }),
    );
    expect(figures.over).toBe(true);
    expect(figures.loadPercent).toBe(150);
    expect(figures.loadLabel).toBe('150%');
    expect(figures.barPercent).toBe(100);
    // The threshold slides left by exactly the overshoot.
    expect(figures.thresholdPercent).toBeCloseTo(66.67, 1);
    expect(figures.markers.map((m) => m.kind)).toContain('over-capacity');
  });

  it('never renders zero capacity as a full bar, Infinity or NaN', () => {
    const figures = deriveCapacityFigures(
      makePersonLoad({
        capacityHours: 0,
        committedHours: 12,
        load: null,
        partialCapacity: true,
      }),
    );
    expect(figures.hasCapacity).toBe(false);
    expect(figures.load).toBeNull();
    expect(figures.loadPercent).toBeNull();
    expect(figures.loadLabel).toBe('No capacity');
    expect(figures.barPercent).toBe(0);
    expect(Number.isFinite(figures.thresholdPercent)).toBe(true);
    expect(figures.over).toBe(false);
    expect(figures.markers.map((m) => m.kind)).toContain('no-capacity');
  });

  it('derives load when the BFF sent none but capacity is known', () => {
    const figures = deriveCapacityFigures(
      makePersonLoad({ capacityHours: 50, committedHours: 25, load: null }),
    );
    expect(figures.load).toBeCloseTo(0.5, 5);
    expect(figures.barPercent).toBeCloseTo(50, 5);
    expect(figures.thresholdPercent).toBe(100);
  });

  it('keeps card count and hours separate for cards with no hours', () => {
    const figures = deriveCapacityFigures(
      makePersonLoad({ cardCount: 6, cardsWithoutRemainingWork: 2 }),
    );
    expect(figures.cardsLabel).toBe('6 cards, 2 without hours');
    expect(figures.markers.map((m) => m.kind)).toContain('cards-without-hours');
  });

  it('marks partial capacity from a team with no record', () => {
    const person = makePersonLoad({ partialCapacity: true });
    const team = person.perTeam[0];
    if (!team) throw new Error('fixture must have a team');
    const figures = deriveCapacityFigures({
      ...person,
      perTeam: [
        team,
        {
          ...team,
          teamId: 'team-data',
          teamName: 'Data and AI',
          hasCapacityRecord: false,
          capacityPerDay: 0,
          capacityHours: 0,
          committedHours: 8,
        },
      ],
    });
    const marker = figures.markers.find((m) => m.kind === 'partial-capacity');
    expect(marker?.detail).toContain('Data and AI');
    expect(figures.teamsWithoutCapacityRecord).toHaveLength(1);
  });
});

describe('selection helpers', () => {
  it('sorts by load, drops hidden people and counts footnotes', () => {
    const people = [
      makePersonLoad({ descriptor: 'a', displayName: 'A', load: 0.4 }),
      makePersonLoad({
        descriptor: 'b',
        displayName: 'B',
        load: 1.2,
        outOfScopeTeamCount: 2,
      }),
      makePersonLoad({ descriptor: 'c', displayName: 'C', hidden: true }),
    ];
    expect(sortPeopleByLoad(people).map((p) => p.descriptor)).toEqual([
      'b',
      'a',
    ]);
    expect(countPeopleWithOutOfScopeTeams(people)).toBe(1);
    expect(findPersonLoad(people, 'a')?.displayName).toBe('A');
    expect(findPersonLoad(people, null)).toBeNull();
  });

  it('formats hours without trailing zeroes', () => {
    expect(formatHours(42)).toBe('42');
    expect(formatHours(7.25)).toBe('7.3');
    expect(formatHours(Number.NaN)).toBe('0');
  });
});
