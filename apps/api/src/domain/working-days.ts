/**
 * Calendar maths for iteration windows and capacity.
 *
 * Spec: "Capacity and the per-person view" — working days come from each
 * team's own working-days setting, so a team on a four-day week must come
 * out right, and "Iteration alignment" — a swimlane shows "day 2 of 15".
 *
 * Everything here is pure and works in whole UTC days. Azure DevOps
 * expresses iteration and days-off boundaries as instants at midnight
 * UTC, so a day is the unit and a `Date` never leaks into a comparison.
 */
import type { AdoDateRange } from '../ado/types.js';

/** Day names exactly as Azure DevOps team settings spells them. */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Used when a team's working-days setting was not supplied. */
export const DEFAULT_WORKING_DAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days since 1970-01-01 UTC. Comparing these instead of instants
 * keeps "is this day off" free of timezone drift.
 */
export type EpochDay = number;

/**
 * Guard against absurd data: a malformed iteration must not spin a loop
 * for a million days. Ten years is far beyond any real sprint.
 */
export const MAX_WINDOW_DAYS = 3660;

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses an Azure DevOps date. Accepts `YYYY-MM-DD` and full ISO
 * instants; a value with no zone is read as UTC, which is what the
 * service means. Returns null rather than throwing on anything else.
 */
export function parseEpochDay(
  value: string | null | undefined,
): EpochDay | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (DATE_ONLY.test(candidate)) candidate = `${candidate}T00:00:00Z`;
  else if (!HAS_ZONE.test(candidate)) candidate = `${candidate}Z`;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / MS_PER_DAY);
}

/** The UTC day a `Date` falls on. */
export function epochDayOf(date: Date): EpochDay {
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.floor(time / MS_PER_DAY);
}

/** Midnight UTC on that day. */
export function dateOfEpochDay(day: EpochDay): Date {
  return new Date(day * MS_PER_DAY);
}

/** `YYYY-MM-DD` for that day. */
export function isoDateOfEpochDay(day: EpochDay): string {
  return dateOfEpochDay(day).toISOString().slice(0, 10);
}

/** ISO instant at midnight UTC, the shape `TeamIterationWindow` wants. */
export function isoTimestampOfEpochDay(day: EpochDay): string {
  return dateOfEpochDay(day).toISOString();
}

/** 1970-01-01 was a Thursday, which anchors the whole calculation. */
export function weekdayOf(day: EpochDay): Weekday {
  const index = ((((day % 7) + 7) % 7) + 4) % 7;
  const name = WEEKDAYS[index];
  // Index is always in range; the fallback exists only for the checker.
  return name ?? 'thursday';
}

/** Normalises a working-days setting, falling back to Monday–Friday. */
export function toWorkingDaySet(
  days?: readonly Weekday[] | null,
): ReadonlySet<Weekday> {
  if (days === undefined || days === null || days.length === 0) {
    return new Set(DEFAULT_WORKING_DAYS);
  }
  return new Set(days);
}

export function isWorkingDay(
  day: EpochDay,
  workingDays: ReadonlySet<Weekday>,
): boolean {
  return workingDays.has(weekdayOf(day));
}

/**
 * Working days in `[start, end]`, both ends inclusive. Returns 0 when the
 * range is empty or inverted, so a bad iteration reads as "no capacity"
 * rather than as a negative one.
 */
export function countWorkingDays(
  start: EpochDay | null,
  end: EpochDay | null,
  workingDays: ReadonlySet<Weekday>,
): number {
  if (start === null || end === null) return 0;
  if (end < start) return 0;
  const last = Math.min(end, start + MAX_WINDOW_DAYS);
  let count = 0;
  for (let day = start; day <= last; day += 1) {
    if (isWorkingDay(day, workingDays)) count += 1;
  }
  return count;
}

/**
 * Working days removed by days off, counted once however many ranges
 * cover them: a personal day off that falls on a team day off is one day,
 * not two. Ranges are clamped to the iteration first, so a leave record
 * spanning the whole year costs one sprint's worth of days.
 */
export function countWorkingDaysOff(
  ranges: readonly AdoDateRange[],
  bounds: { readonly start: EpochDay | null; readonly end: EpochDay | null },
  workingDays: ReadonlySet<Weekday>,
): number {
  const { start, end } = bounds;
  if (start === null || end === null || end < start) return 0;
  const last = Math.min(end, start + MAX_WINDOW_DAYS);
  const off = new Set<EpochDay>();
  for (const range of ranges) {
    const rangeStart = parseEpochDay(range.start);
    const rangeEnd = parseEpochDay(range.end) ?? rangeStart;
    if (rangeStart === null || rangeEnd === null) continue;
    const from = Math.max(rangeStart, start);
    const to = Math.min(rangeEnd, last);
    for (let day = from; day <= to; day += 1) {
      if (isWorkingDay(day, workingDays)) off.add(day);
    }
  }
  return off.size;
}

/** True when the two inclusive day ranges share at least one day. */
export function rangesOverlap(
  a: { readonly start: EpochDay | null; readonly end: EpochDay | null },
  b: { readonly start: EpochDay; readonly end: EpochDay },
): boolean {
  if (a.start === null || a.end === null) return false;
  return a.start <= b.end && b.start <= a.end;
}

/** Rounds away binary-floating-point noise before a number goes on the wire. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
