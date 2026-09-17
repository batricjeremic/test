/**
 * Swimlanes: grouping by person or by team.
 *
 * Spec: "Scope and non-goals" — two groupings, a swimlane per assignee or
 * a swimlane per team — and the capacity edge-case table: a card assigned
 * to a group or to nobody goes to an Unassigned lane pinned at the top
 * and never hidden.
 *
 * Security trimming shows up here too: a lane that would be empty because
 * its cards were trimmed is still rendered, with a count, so a person
 * knows something exists without seeing what.
 */
import { UNASSIGNED_LANE_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardGrouping,
  BoardSwimlane,
  Descriptor,
  PersonOverride,
} from '@eg/shared';
import { personDescriptorOf, remainingWorkHours } from './cards.js';
import type { TeamBoardContext } from './mapping.js';
import { compareLabels, compareStrings } from './sorting.js';
import { roundTo } from './working-days.js';

/** Lane ids are deterministic, so a caller can key counts on them. */
export function personLaneId(descriptor: Descriptor): string {
  return `person:${descriptor}`;
}

export function teamLaneId(teamId: string): string {
  return `team:${teamId}`;
}

/** Label for the lane that holds group-assigned and unassigned cards. */
export const UNASSIGNED_LANE_LABEL = 'Unassigned';

/** Descriptors a `PersonOverride` hides from the board. */
export function hiddenDescriptors(
  overrides: readonly PersonOverride[],
): ReadonlySet<Descriptor> {
  return new Set(
    overrides
      .filter((override) => override.hidden)
      .map((override) => override.descriptor),
  );
}

/**
 * Splits off the cards of people an admin has hidden. They are removed
 * from the board rather than falling into the Unassigned lane, and the
 * caller counts them so the removal is visible.
 */
export function partitionHiddenCards(
  cards: readonly BoardCard[],
  hidden: ReadonlySet<Descriptor>,
): { readonly visible: BoardCard[]; readonly hidden: BoardCard[] } {
  const visible: BoardCard[] = [];
  const removed: BoardCard[] = [];
  for (const card of cards) {
    const descriptor = personDescriptorOf(card);
    if (descriptor !== null && hidden.has(descriptor)) removed.push(card);
    else visible.push(card);
  }
  return { visible, hidden: removed };
}

export interface SwimlaneInput {
  readonly grouping: BoardGrouping;
  /** Cards the caller may see. */
  readonly cards: readonly BoardCard[];
  /** Cards security trimming removed; they contribute counts only. */
  readonly trimmedCards?: readonly BoardCard[];
  readonly teams: readonly TeamBoardContext[];
  readonly overrides?: readonly PersonOverride[];
}

interface LaneAccumulator {
  id: string;
  kind: 'person' | 'team' | 'unassigned';
  label: string;
  personDescriptor: string | null;
  teamId: string | null;
  cardCount: number;
  hiddenCardCount: number;
  remainingWorkHours: number;
  cardsWithoutRemainingWork: number;
  sortKey: string;
}

/**
 * Builds every lane the snapshot renders. The Unassigned lane is pinned
 * at order 0 whenever it can hold a card; the rest follow in a stable
 * order — display name for people, project and team name for teams.
 */
export function buildSwimlanes(input: SwimlaneInput): BoardSwimlane[] {
  const overrides = new Map<Descriptor, PersonOverride>();
  for (const override of input.overrides ?? []) {
    overrides.set(override.descriptor, override);
  }

  const lanes = new Map<string, LaneAccumulator>();

  const unassignedLane = (): LaneAccumulator => ({
    id: UNASSIGNED_LANE_ID,
    kind: 'unassigned',
    label: UNASSIGNED_LANE_LABEL,
    personDescriptor: null,
    teamId: null,
    cardCount: 0,
    hiddenCardCount: 0,
    remainingWorkHours: 0,
    cardsWithoutRemainingWork: 0,
    sortKey: '',
  });

  const ensure = (id: string, make: () => LaneAccumulator): LaneAccumulator => {
    const existing = lanes.get(id);
    if (existing !== undefined) return existing;
    const created = make();
    lanes.set(id, created);
    return created;
  };

  if (input.grouping === 'person') {
    // Pinned at the top and never hidden, even with nothing in it.
    ensure(UNASSIGNED_LANE_ID, unassignedLane);
  }

  if (input.grouping === 'team') {
    for (const team of input.teams) {
      ensure(teamLaneId(team.teamId), () => ({
        id: teamLaneId(team.teamId),
        kind: 'team',
        label: team.teamName.length > 0 ? team.teamName : team.teamId,
        personDescriptor: null,
        teamId: team.teamId,
        cardCount: 0,
        hiddenCardCount: 0,
        remainingWorkHours: 0,
        cardsWithoutRemainingWork: 0,
        sortKey: `${team.projectName}\u0000${team.teamName}\u0000${team.teamId}`,
      }));
    }
  }

  const laneFor = (card: BoardCard): LaneAccumulator => {
    if (input.grouping === 'team') {
      const lane = lanes.get(teamLaneId(card.teamId));
      if (lane !== undefined) return lane;
      // A card whose team is not on the board still has to land somewhere
      // visible rather than disappearing.
      return ensure(UNASSIGNED_LANE_ID, unassignedLane);
    }

    const descriptor = personDescriptorOf(card);
    if (descriptor === null) return ensure(UNASSIGNED_LANE_ID, unassignedLane);
    const id = personLaneId(descriptor);
    const lane = ensure(id, () => {
      const override = overrides.get(descriptor);
      const overrideName = override?.displayName ?? '';
      const label =
        overrideName.length > 0
          ? overrideName
          : (card.assignedTo?.displayName ?? descriptor);
      return {
        id,
        kind: 'person',
        label: label.length > 0 ? label : descriptor,
        personDescriptor: descriptor,
        teamId: null,
        cardCount: 0,
        hiddenCardCount: 0,
        remainingWorkHours: 0,
        cardsWithoutRemainingWork: 0,
        sortKey: '',
      };
    });
    return lane;
  };

  for (const card of input.cards) {
    const lane = laneFor(card);
    lane.cardCount += 1;
    const hours = remainingWorkHours(card);
    if (hours === null) lane.cardsWithoutRemainingWork += 1;
    else lane.remainingWorkHours += hours;
  }

  for (const card of input.trimmedCards ?? []) {
    laneFor(card).hiddenCardCount += 1;
  }

  const ordered = [...lanes.values()].sort((a, b) => {
    if (a.kind === 'unassigned') return b.kind === 'unassigned' ? 0 : -1;
    if (b.kind === 'unassigned') return 1;
    if (a.kind === 'team' && b.kind === 'team') {
      return compareLabels(a.sortKey, b.sortKey) || compareStrings(a.id, b.id);
    }
    return compareLabels(a.label, b.label) || compareStrings(a.id, b.id);
  });

  return ordered.map((lane, order) => ({
    id: lane.id,
    kind: lane.kind,
    label: lane.label,
    personDescriptor: lane.personDescriptor,
    teamId: lane.teamId,
    order,
    cardCount: lane.cardCount,
    hiddenCardCount: lane.hiddenCardCount,
    remainingWorkHours: roundTo(lane.remainingWorkHours, 2),
    cardsWithoutRemainingWork: lane.cardsWithoutRemainingWork,
  }));
}
