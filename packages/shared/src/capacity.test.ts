import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOAD_THRESHOLD,
  personLoadSchema,
  personTeamCapacitySchema,
} from './capacity.js';

const teamCapacity = {
  projectId: 'proj-1',
  teamId: 'team-dev',
  teamName: 'Dev',
  iterationId: 'iter-24',
  hasCapacityRecord: true,
  capacityPerDay: 6,
  workingDays: 10,
  daysOff: 2,
  capacityHours: 48,
  committedHours: 30,
  cardCount: 5,
};

const load = {
  descriptor: 'aad.YWJj',
  displayName: 'A. Person',
  hidden: false,
  capacityHours: 48,
  committedHours: 30,
  load: 0.625,
  partialCapacity: false,
  outOfScopeTeamCount: 0,
  cardCount: 5,
  cardsWithoutRemainingWork: 1,
  perTeam: [teamCapacity],
  computedAt: '2026-09-17T08:00:00Z',
};

describe('personTeamCapacitySchema', () => {
  it('round-trips a team contribution', () => {
    expect(personTeamCapacitySchema.parse(teamCapacity)).toEqual(teamCapacity);
  });

  it('round-trips a team with no capacity record as zero hours', () => {
    const none = {
      ...teamCapacity,
      hasCapacityRecord: false,
      capacityPerDay: 0,
      capacityHours: 0,
    };
    expect(personTeamCapacitySchema.parse(none)).toEqual(none);
  });

  it('rejects negative capacity', () => {
    const result = personTeamCapacitySchema.safeParse({
      ...teamCapacity,
      capacityHours: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('personLoadSchema', () => {
  it('round-trips a person on one team', () => {
    expect(personLoadSchema.parse(load)).toEqual(load);
  });

  it('carries the partial-capacity and out-of-scope markers', () => {
    const partial = {
      ...load,
      capacityHours: 0,
      load: null,
      partialCapacity: true,
      outOfScopeTeamCount: 2,
      perTeam: [{ ...teamCapacity, hasCapacityRecord: false }],
    };
    const parsed = personLoadSchema.parse(partial);
    expect(parsed.load).toBeNull();
    expect(parsed.partialCapacity).toBe(true);
    expect(parsed.outOfScopeTeamCount).toBe(2);
  });

  it('sums across teams with different iteration lengths', () => {
    const twoTeams = {
      ...load,
      perTeam: [
        teamCapacity,
        { ...teamCapacity, teamId: 'team-data', workingDays: 15 },
      ],
    };
    expect(personLoadSchema.parse(twoTeams).perTeam).toHaveLength(2);
  });

  it('rejects a load that is neither a number nor null', () => {
    const result = personLoadSchema.safeParse({ ...load, load: 'over' });
    expect(result.success).toBe(false);
  });

  it('rejects a computedAt that is not an instant', () => {
    const result = personLoadSchema.safeParse({
      ...load,
      computedAt: '2026-09-17',
    });
    expect(result.success).toBe(false);
  });

  it('marks over-loaded people at the threshold', () => {
    expect(DEFAULT_LOAD_THRESHOLD).toBe(1);
  });
});
