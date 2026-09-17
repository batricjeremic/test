import { describe, expect, it } from 'vitest';
import {
  countWorkingDays,
  countWorkingDaysOff,
  DEFAULT_WORKING_DAYS,
  epochDayOf,
  isoDateOfEpochDay,
  isoTimestampOfEpochDay,
  MAX_WINDOW_DAYS,
  parseEpochDay,
  rangesOverlap,
  roundTo,
  toWorkingDaySet,
  weekdayOf,
} from './working-days.js';
import type { Weekday } from './working-days.js';
import { days } from './test-support.js';

const MON_FRI = toWorkingDaySet(DEFAULT_WORKING_DAYS);
const FOUR_DAY: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
];

describe('parseEpochDay', () => {
  it.each([
    ['2026-09-14', '2026-09-14'],
    ['2026-09-14T00:00:00Z', '2026-09-14'],
    ['2026-09-14T23:59:59Z', '2026-09-14'],
    ['2026-09-14T00:00:00', '2026-09-14'],
    ['2026-09-14T02:00:00+02:00', '2026-09-14'],
    ['  2026-09-14  ', '2026-09-14'],
  ])('reads %s as %s', (input, expected) => {
    const day = parseEpochDay(input);
    expect(day).not.toBeNull();
    expect(isoDateOfEpochDay(day ?? 0)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', 'not a date', '2026-13-45'])(
    'returns null for %s rather than throwing',
    (input) => {
      expect(parseEpochDay(input)).toBeNull();
    },
  );
});

describe('weekdayOf', () => {
  it.each([
    ['2026-09-13', 'sunday'],
    ['2026-09-14', 'monday'],
    ['2026-09-17', 'thursday'],
    ['2026-09-19', 'saturday'],
    ['1970-01-01', 'thursday'],
    ['1969-12-31', 'wednesday'],
  ])('%s is a %s', (date, expected) => {
    expect(weekdayOf(parseEpochDay(date) ?? 0)).toBe(expected);
  });
});

describe('countWorkingDays', () => {
  const start = parseEpochDay('2026-09-14') ?? 0;
  const end = parseEpochDay('2026-09-25') ?? 0;

  it('counts a two-week sprint as ten days on a five-day week', () => {
    expect(countWorkingDays(start, end, MON_FRI)).toBe(10);
  });

  it('counts the same sprint as eight days on a four-day week', () => {
    expect(countWorkingDays(start, end, toWorkingDaySet(FOUR_DAY))).toBe(8);
  });

  it('includes both ends', () => {
    expect(countWorkingDays(start, start, MON_FRI)).toBe(1);
  });

  it('is zero for an inverted or unknown range', () => {
    expect(countWorkingDays(end, start, MON_FRI)).toBe(0);
    expect(countWorkingDays(null, end, MON_FRI)).toBe(0);
    expect(countWorkingDays(start, null, MON_FRI)).toBe(0);
  });

  it('clamps an absurd window rather than looping forever', () => {
    const counted = countWorkingDays(start, start + 10_000_000, MON_FRI);
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(MAX_WINDOW_DAYS + 1);
  });

  it('falls back to Monday–Friday when a team has no setting', () => {
    expect(countWorkingDays(start, end, toWorkingDaySet(null))).toBe(10);
    expect(countWorkingDays(start, end, toWorkingDaySet([]))).toBe(10);
  });
});

describe('countWorkingDaysOff', () => {
  const bounds = {
    start: parseEpochDay('2026-09-14'),
    end: parseEpochDay('2026-09-25'),
  };

  it('counts only working days', () => {
    // 19th and 20th are a weekend; only the 18th counts.
    expect(
      countWorkingDaysOff([days('2026-09-18', '2026-09-20')], bounds, MON_FRI),
    ).toBe(1);
  });

  it('counts a day off once when person and team both have it', () => {
    const personal = days('2026-09-16', '2026-09-17');
    const team = days('2026-09-17', '2026-09-18');
    expect(countWorkingDaysOff([personal, team], bounds, MON_FRI)).toBe(3);
  });

  it('clamps a range that runs past the iteration', () => {
    expect(
      countWorkingDaysOff([days('2020-01-01', '2030-01-01')], bounds, MON_FRI),
    ).toBe(10);
  });

  it('ignores ranges outside the iteration and unparsable ones', () => {
    expect(
      countWorkingDaysOff(
        [days('2026-08-01', '2026-08-05'), days('nonsense', 'worse')],
        bounds,
        MON_FRI,
      ),
    ).toBe(0);
  });

  it('is zero when the iteration has no dates', () => {
    expect(
      countWorkingDaysOff(
        [days('2026-09-16')],
        { start: null, end: null },
        MON_FRI,
      ),
    ).toBe(0);
  });
});

describe('rangesOverlap', () => {
  const window = {
    start: parseEpochDay('2026-09-01') ?? 0,
    end: parseEpochDay('2026-09-30') ?? 0,
  };

  it.each([
    ['2026-09-10', '2026-09-20', true],
    ['2026-08-01', '2026-09-01', true],
    ['2026-09-30', '2026-10-15', true],
    ['2026-08-01', '2026-08-31', false],
    ['2026-10-01', '2026-10-31', false],
  ])('%s..%s overlaps: %s', (start, end, expected) => {
    expect(
      rangesOverlap(
        { start: parseEpochDay(start), end: parseEpochDay(end) },
        window,
      ),
    ).toBe(expected);
  });

  it('never overlaps when the iteration has no dates', () => {
    expect(rangesOverlap({ start: null, end: null }, window)).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('renders a day as a date and as an instant', () => {
    const day = parseEpochDay('2026-09-14') ?? 0;
    expect(isoDateOfEpochDay(day)).toBe('2026-09-14');
    expect(isoTimestampOfEpochDay(day)).toBe('2026-09-14T00:00:00.000Z');
  });

  it('reads the day a Date falls on in UTC', () => {
    expect(
      isoDateOfEpochDay(epochDayOf(new Date('2026-09-17T23:30:00Z'))),
    ).toBe('2026-09-17');
  });

  it('rounds floating point noise away', () => {
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1 / 3, 4)).toBe(0.3333);
    expect(roundTo(Number.NaN, 2)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY, 2)).toBe(0);
  });
});
