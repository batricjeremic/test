/**
 * Per-person capacity and load — the reason the product exists.
 *
 * Spec: "Capacity and the per-person view". A person on three teams has
 * three capacity records and no view that adds them up. Capacity is the
 * sum over their teams of `capacityPerDay x working days in THAT team's
 * iteration`, minus personal days off and team days off, using each
 * team's own working-days setting. Committed is the sum of
 * `Microsoft.VSTS.Scheduling.RemainingWork` across every in-scope
 * project. Load is committed over capacity — one person, one bar, with
 * the per-team split underneath.
 *
 * Every row of the spec's edge-case table lives here: a missing capacity
 * record counts as zero for that team and raises `partialCapacity`; a
 * card with no remaining work is counted but contributes no hours; group
 * and unassigned cards are not a person's load at all; a team outside the
 * board's scope is excluded but counted; teams with different iteration
 * lengths are computed over their own dates and then summed. Division by
 * a zero capacity yields null, never Infinity or NaN.
 */
import type {
  BoardCard,
  Descriptor,
  PersonLoad,
  PersonOverride,
  PersonTeamCapacity,
} from '@eg/shared';
import type {
  AdoDateRange,
  AdoTeamMemberCapacity,
  AdoTeamSettingsDaysOff,
} from '../ado/types.js';
import type { Clock } from '../ports.js';
import { personDescriptorOf, remainingWorkHours } from './cards.js';
import type { ResolvedTeamIteration } from './iteration.js';
import type { TeamBoardContext } from './mapping.js';
import { compareLabels, compareStrings } from './sorting.js';
import { countWorkingDaysOff, roundTo } from './working-days.js';
import { isGroupDescriptor } from './cards.js';

/** One team's capacity records for one iteration in scope. */
export interface TeamCapacityInput {
  readonly team: TeamBoardContext;
  readonly iteration: ResolvedTeamIteration;
  readonly capacities: readonly AdoTeamMemberCapacity[];
  readonly teamDaysOff: AdoTeamSettingsDaysOff | null;
}

/**
 * A team a person belongs to, including teams this board does not cover.
 * Those become the footnote count, so nobody reads the bar as complete.
 */
export interface PersonTeamMembership {
  readonly descriptor: Descriptor;
  readonly teamId: string;
}

export interface PersonLoadInput {
  readonly teams: readonly TeamCapacityInput[];
  /** Cards already filtered and security-trimmed to what the caller sees. */
  readonly cards: readonly BoardCard[];
  readonly overrides?: readonly PersonOverride[];
  readonly memberships?: readonly PersonTeamMembership[];
  readonly clock: Clock;
}

interface MemberCapacity {
  readonly capacityPerDay: number;
  readonly daysOff: readonly AdoDateRange[];
  readonly displayName: string;
}

interface CardTotals {
  cardCount: number;
  cardsWithoutRemainingWork: number;
  committedHours: number;
}

const emptyTotals = (): CardTotals => ({
  cardCount: 0,
  cardsWithoutRemainingWork: 0,
  committedHours: 0,
});

const scopeKey = (teamId: string, iterationId: string): string =>
  `${teamId}\u0000${iterationId}`;

/** Sum of a member's activity capacities, in hours per working day. */
export function capacityPerDayOf(record: AdoTeamMemberCapacity): number {
  let total = 0;
  for (const activity of record.activities) {
    if (Number.isFinite(activity.capacityPerDay)) {
      total += activity.capacityPerDay;
    }
  }
  return total > 0 ? total : 0;
}

/** The descriptor a capacity record keys on, or null when it has none. */
export function capacityDescriptorOf(
  record: AdoTeamMemberCapacity,
): Descriptor | null {
  const descriptor = record.teamMember.descriptor ?? record.teamMember.id ?? '';
  if (descriptor.length === 0) return null;
  return isGroupDescriptor(descriptor) ? null : descriptor;
}

/**
 * Working days this person actually has on this team: the iteration's
 * own working days less the days off, counted once whether the day is
 * off for the person, for the team, or for both.
 */
export function availableWorkingDays(
  iteration: ResolvedTeamIteration,
  personalDaysOff: readonly AdoDateRange[],
  teamDaysOff: readonly AdoDateRange[],
): { readonly workingDays: number; readonly daysOff: number } {
  const workingDays = iteration.window.workingDaysTotal;
  const daysOff = countWorkingDaysOff(
    [...personalDaysOff, ...teamDaysOff],
    { start: iteration.startDay, end: iteration.endDay },
    iteration.workingDays,
  );
  return { workingDays, daysOff: Math.min(daysOff, workingDays) };
}

/**
 * One `PersonLoad` per person in scope, whatever number of teams they are
 * on. People are ordered by display name then descriptor, so the bar list
 * does not shuffle between refreshes.
 */
export function computePersonLoads(input: PersonLoadInput): PersonLoad[] {
  const computedAt = input.clock.now().toISOString();

  const overrides = new Map<Descriptor, PersonOverride>();
  for (const override of input.overrides ?? []) {
    overrides.set(override.descriptor, override);
  }

  const inScopeTeamIds = new Set(input.teams.map((team) => team.team.teamId));

  /* Capacity records, keyed by (team, iteration) then descriptor. */
  const byScope = new Map<string, Map<Descriptor, MemberCapacity>>();
  const people = new Set<Descriptor>();
  for (const entry of input.teams) {
    const key = scopeKey(entry.team.teamId, entry.iteration.window.iterationId);
    const members = byScope.get(key) ?? new Map<Descriptor, MemberCapacity>();
    for (const record of entry.capacities) {
      const descriptor = capacityDescriptorOf(record);
      if (descriptor === null) continue;
      members.set(descriptor, {
        capacityPerDay: capacityPerDayOf(record),
        daysOff: record.daysOff,
        displayName: record.teamMember.displayName ?? '',
      });
      people.add(descriptor);
    }
    byScope.set(key, members);
  }

  /* Card totals, per person and per person-and-scope. */
  const personTotals = new Map<Descriptor, CardTotals>();
  const scopeTotals = new Map<string, CardTotals>();
  const cardNames = new Map<Descriptor, string>();
  for (const card of input.cards) {
    const descriptor = personDescriptorOf(card);
    if (descriptor === null) continue;
    people.add(descriptor);

    const displayName = card.assignedTo?.displayName ?? '';
    if (displayName.length > 0 && !cardNames.has(descriptor)) {
      cardNames.set(descriptor, displayName);
    }

    const hours = remainingWorkHours(card);
    const person = personTotals.get(descriptor) ?? emptyTotals();
    person.cardCount += 1;
    if (hours === null) person.cardsWithoutRemainingWork += 1;
    else person.committedHours += hours;
    personTotals.set(descriptor, person);

    const key = `${descriptor}\u0000${scopeKey(card.teamId, card.iterationId)}`;
    const scoped = scopeTotals.get(key) ?? emptyTotals();
    scoped.cardCount += 1;
    if (hours === null) scoped.cardsWithoutRemainingWork += 1;
    else scoped.committedHours += hours;
    scopeTotals.set(key, scoped);
  }

  /* Teams a person is on that this board does not cover. */
  const outOfScope = new Map<Descriptor, Set<string>>();
  for (const membership of input.memberships ?? []) {
    if (inScopeTeamIds.has(membership.teamId)) continue;
    if (isGroupDescriptor(membership.descriptor)) continue;
    const teams = outOfScope.get(membership.descriptor) ?? new Set<string>();
    teams.add(membership.teamId);
    outOfScope.set(membership.descriptor, teams);
  }

  const loads: PersonLoad[] = [];
  for (const descriptor of people) {
    const perTeam: PersonTeamCapacity[] = [];
    let capacityHours = 0;
    let partialCapacity = false;

    for (const entry of input.teams) {
      const iterationId = entry.iteration.window.iterationId;
      const key = scopeKey(entry.team.teamId, iterationId);
      const record = byScope.get(key)?.get(descriptor);
      const totals =
        scopeTotals.get(`${descriptor}\u0000${key}`) ?? emptyTotals();

      // A team the person has neither a capacity record nor a card on is
      // simply not theirs, and must not dilute the bar.
      if (record === undefined && totals.cardCount === 0) continue;

      const capacityPerDay = record?.capacityPerDay ?? 0;
      const { workingDays, daysOff } = availableWorkingDays(
        entry.iteration,
        record?.daysOff ?? [],
        entry.teamDaysOff?.daysOff ?? [],
      );
      const teamCapacityHours = roundTo(
        capacityPerDay * Math.max(0, workingDays - daysOff),
        2,
      );
      capacityHours += teamCapacityHours;
      if (record === undefined) partialCapacity = true;

      perTeam.push({
        projectId: entry.team.projectId,
        teamId: entry.team.teamId,
        teamName: entry.team.teamName,
        iterationId,
        hasCapacityRecord: record !== undefined,
        capacityPerDay: roundTo(capacityPerDay, 2),
        workingDays,
        daysOff,
        capacityHours: teamCapacityHours,
        committedHours: roundTo(totals.committedHours, 2),
        cardCount: totals.cardCount,
      });
    }

    perTeam.sort(
      (a, b) =>
        compareStrings(a.projectId, b.projectId) ||
        compareLabels(a.teamName, b.teamName) ||
        compareStrings(a.teamId, b.teamId) ||
        compareStrings(a.iterationId, b.iterationId),
    );

    const totals = personTotals.get(descriptor) ?? emptyTotals();
    const override = overrides.get(descriptor);
    const overrideName = override?.displayName ?? '';
    const capacityName = [...byScope.values()]
      .map((members) => members.get(descriptor)?.displayName ?? '')
      .find((name) => name.length > 0);
    const roundedCapacity = roundTo(capacityHours, 2);
    const roundedCommitted = roundTo(totals.committedHours, 2);

    loads.push({
      descriptor,
      displayName:
        overrideName.length > 0
          ? overrideName
          : (cardNames.get(descriptor) ?? capacityName ?? ''),
      hidden: override?.hidden ?? false,
      capacityHours: roundedCapacity,
      committedHours: roundedCommitted,
      // Never Infinity, never NaN: a bar with no denominator is null.
      load:
        roundedCapacity > 0
          ? roundTo(roundedCommitted / roundedCapacity, 4)
          : null,
      partialCapacity,
      outOfScopeTeamCount: outOfScope.get(descriptor)?.size ?? 0,
      cardCount: totals.cardCount,
      cardsWithoutRemainingWork: totals.cardsWithoutRemainingWork,
      perTeam,
      computedAt,
    });
  }

  return loads.sort(
    (a, b) =>
      compareLabels(a.displayName, b.displayName) ||
      compareStrings(a.descriptor, b.descriptor),
  );
}
