/**
 * The arithmetic of rendering one person's load bar honestly.
 *
 * The BFF already did the capacity sums (spec: "Capacity and the
 * per-person view"), so nothing here recomputes hours. What it does is
 * turn a `PersonLoad` into numbers a bar can be drawn from without ever
 * producing `Infinity`, `NaN` or a full bar for an unknown denominator,
 * and into the markers the spec's edge-case table requires.
 */
import { DEFAULT_LOAD_THRESHOLD } from '@eg/shared';
import type { PersonLoad, PersonTeamCapacity } from '@eg/shared';

/** One reason the bar alone would be misleading. */
export type CapacityMarkerKind =
  | 'over-capacity'
  | 'partial-capacity'
  | 'no-capacity'
  | 'cards-without-hours'
  | 'out-of-scope-teams';

export type CapacityMarker = {
  readonly kind: CapacityMarkerKind;
  /** Badge text. Short enough for a lane header. */
  readonly label: string;
  /** Full sentence, used as the badge title and in the summary variant. */
  readonly detail: string;
};

/** Everything the bar, the lane header and the summary card render. */
export type CapacityFigures = {
  readonly descriptor: string;
  readonly displayName: string;
  readonly capacityHours: number;
  readonly committedHours: number;
  /** `committedHours / capacityHours`, or null when there is no capacity. */
  readonly load: number | null;
  /** Whole-percent load, or null when unknown. Never NaN or Infinity. */
  readonly loadPercent: number | null;
  /** Fill width as a percentage of the track, 0-100. */
  readonly barPercent: number;
  /** Where the threshold marker sits on the track, 0-100. */
  readonly thresholdPercent: number;
  readonly threshold: number;
  readonly over: boolean;
  /** False when capacity is zero or unknown: the bar must stay empty. */
  readonly hasCapacity: boolean;
  /** `70%` or `No capacity`. Rendered next to the bar, never instead. */
  readonly loadLabel: string;
  /** `42 of 60 h`, or `42 h committed` when capacity is unknown. */
  readonly hoursLabel: string;
  /** `6 cards, 1 without hours` — both numbers, per the edge-case table. */
  readonly cardsLabel: string;
  readonly cardCount: number;
  readonly cardsWithoutRemainingWork: number;
  readonly outOfScopeTeamCount: number;
  readonly teamCount: number;
  /** The person's in-scope teams with no capacity record on them. */
  readonly teamsWithoutCapacityRecord: readonly PersonTeamCapacity[];
  readonly markers: readonly CapacityMarker[];
  /** One sentence, used as the bar's accessible name. */
  readonly summary: string;
};

/** A finite, non-negative number, or `fallback` for anything else. */
function safeNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Hours with at most one decimal and no trailing `.0`. */
export function formatHours(value: number): string {
  const safe = safeNumber(value);
  return (Math.round(safe * 10) / 10).toString();
}

/** Whole percent, clamped so a wild denominator cannot escape the bar. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function pluralCards(count: number): string {
  return count === 1 ? '1 card' : `${count} cards`;
}

function buildMarkers(
  person: PersonLoad,
  hasCapacity: boolean,
  over: boolean,
  teamsWithoutRecord: readonly PersonTeamCapacity[],
): CapacityMarker[] {
  const markers: CapacityMarker[] = [];
  if (over) {
    markers.push({
      kind: 'over-capacity',
      label: 'Over capacity',
      detail: `${formatHours(person.committedHours)} h committed against ${formatHours(person.capacityHours)} h of capacity.`,
    });
  }
  if (!hasCapacity) {
    markers.push({
      kind: 'no-capacity',
      label: 'No capacity',
      detail:
        'No capacity is recorded for this person in the selected window, so load cannot be calculated.',
    });
  }
  if (person.partialCapacity || teamsWithoutRecord.length > 0) {
    const names = teamsWithoutRecord
      .map((team) => team.teamName)
      .filter((name) => name.length > 0);
    const where = names.length > 0 ? ` Missing on: ${names.join(', ')}.` : '';
    markers.push({
      kind: 'partial-capacity',
      label: 'Partial capacity',
      detail: `Capacity is missing on at least one of this person's teams, so the bar understates their load.${where}`,
    });
  }
  if (person.cardsWithoutRemainingWork > 0) {
    markers.push({
      kind: 'cards-without-hours',
      label: `${person.cardsWithoutRemainingWork} without hours`,
      detail: `${pluralCards(person.cardsWithoutRemainingWork)} ${
        person.cardsWithoutRemainingWork === 1 ? 'has' : 'have'
      } no remaining work: counted in the card count, excluded from the hours.`,
    });
  }
  if (person.outOfScopeTeamCount > 0) {
    markers.push({
      kind: 'out-of-scope-teams',
      label: `${person.outOfScopeTeamCount} team${person.outOfScopeTeamCount === 1 ? '' : 's'} out of scope`,
      detail: `This person is also on ${person.outOfScopeTeamCount} team${person.outOfScopeTeamCount === 1 ? '' : 's'} the board does not cover, so this bar is not their whole load.`,
    });
  }
  return markers;
}

/**
 * Turn one `PersonLoad` into render-ready figures.
 *
 * The track is scaled to `max(capacity x threshold, committed)`, so an
 * over-loaded person fills it and the threshold marker slides left by
 * exactly the overshoot. Zero or unknown capacity gives an empty bar and
 * a `No capacity` label, never a full one.
 */
export function deriveCapacityFigures(
  person: PersonLoad,
  options: { threshold?: number } = {},
): CapacityFigures {
  const threshold = safeNumber(options.threshold ?? DEFAULT_LOAD_THRESHOLD, 1);
  const capacityHours = safeNumber(person.capacityHours);
  const committedHours = safeNumber(person.committedHours);
  const hasCapacity = capacityHours > 0;

  const reported =
    person.load !== null && Number.isFinite(person.load) && person.load >= 0
      ? person.load
      : null;
  const load = hasCapacity
    ? (reported ?? committedHours / capacityHours)
    : null;
  const loadPercent = load === null ? null : Math.round(load * 100);
  const over = load !== null && threshold > 0 && load >= threshold;

  const thresholdHours = capacityHours * threshold;
  const scale = Math.max(thresholdHours, committedHours);
  const barPercent =
    hasCapacity && scale > 0
      ? Math.min(100, (committedHours / scale) * 100)
      : 0;
  const thresholdPercent =
    hasCapacity && scale > 0
      ? Math.min(100, (thresholdHours / scale) * 100)
      : 100;

  const teamsWithoutCapacityRecord = person.perTeam.filter(
    (team) => !team.hasCapacityRecord,
  );
  const markers = buildMarkers(
    person,
    hasCapacity,
    over,
    teamsWithoutCapacityRecord,
  );

  const loadLabel =
    loadPercent === null ? 'No capacity' : formatPercent(loadPercent);
  const hoursLabel = hasCapacity
    ? `${formatHours(committedHours)} of ${formatHours(capacityHours)} h`
    : `${formatHours(committedHours)} h committed`;
  const cardsLabel =
    person.cardsWithoutRemainingWork > 0
      ? `${pluralCards(person.cardCount)}, ${person.cardsWithoutRemainingWork} without hours`
      : pluralCards(person.cardCount);

  const summary = [
    `${person.displayName}: ${loadLabel} loaded`,
    hoursLabel,
    cardsLabel,
    ...markers
      .filter((marker) => marker.kind !== 'cards-without-hours')
      .map((marker) => marker.label),
  ].join('. ');

  return {
    descriptor: person.descriptor,
    displayName: person.displayName,
    capacityHours,
    committedHours,
    load,
    loadPercent,
    barPercent,
    thresholdPercent,
    threshold,
    over,
    hasCapacity,
    loadLabel,
    hoursLabel,
    cardsLabel,
    cardCount: person.cardCount,
    cardsWithoutRemainingWork: person.cardsWithoutRemainingWork,
    outOfScopeTeamCount: person.outOfScopeTeamCount,
    teamCount: person.perTeam.length,
    teamsWithoutCapacityRecord,
    markers,
    summary,
  };
}

/** Visible people, heaviest first, so whoever is over is at the top. */
export function sortPeopleByLoad(
  people: readonly PersonLoad[],
): readonly PersonLoad[] {
  return [...people]
    .filter((person) => !person.hidden)
    .sort((a, b) => {
      const left = a.load ?? -1;
      const right = b.load ?? -1;
      if (left !== right) return right - left;
      return a.displayName.localeCompare(b.displayName);
    });
}

/** The one person a swimlane is about, or null when nobody matches. */
export function findPersonLoad(
  people: readonly PersonLoad[],
  descriptor: string | null,
): PersonLoad | null {
  if (descriptor === null) return null;
  return people.find((person) => person.descriptor === descriptor) ?? null;
}

/** Board-wide footnote: how many people have teams outside this board. */
export function countPeopleWithOutOfScopeTeams(
  people: readonly PersonLoad[],
): number {
  return people.filter((person) => person.outOfScopeTeamCount > 0).length;
}
