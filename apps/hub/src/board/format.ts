/**
 * Small display formatters. Kept pure and free of React so the grid, the
 * announcements and the tests all read the same sentence.
 */
import type { BoardCard, BoardSwimlane, TeamIterationWindow } from '@eg/shared';

/** "day 2 of 15", the spec's mixed-cadence phrasing. */
export function formatSprintDay(window: TeamIterationWindow): string {
  const total = window.workingDaysTotal;
  if (total === 0) return 'no working days';
  const elapsed = Math.min(window.workingDaysElapsed, total);
  return `day ${elapsed} of ${total}`;
}

/** "15 Sep – 26 Sep", or an empty string when the dates are unknown. */
export function formatSprintDates(window: TeamIterationWindow): string {
  const start = formatDay(window.startDate);
  const finish = formatDay(window.finishDate);
  if (start === null && finish === null) return '';
  return `${start ?? '?'} – ${finish ?? '?'}`;
}

/** The whole sprint line for a lane header or a team badge. */
export function formatIterationLine(window: TeamIterationWindow): string {
  const dates = formatSprintDates(window);
  const day = formatSprintDay(window);
  const name = window.iterationName || window.iterationPath;
  const parts = [`${window.teamName}: ${name}`, day];
  if (dates !== '') parts.push(dates);
  return parts.join(' · ');
}

function formatDay(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/** "4 h", "0.5 h", or an em dash when a card carries no estimate. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} h`;
}

/**
 * The lane header's numbers. Hours and card count sit side by side
 * because a card with no remaining work still counts as work.
 */
export function formatLaneTotals(lane: BoardSwimlane): string {
  const cards = `${lane.cardCount} ${lane.cardCount === 1 ? 'card' : 'cards'}`;
  const parts = [cards, `${roundHours(lane.remainingWorkHours)} h remaining`];
  if (lane.cardsWithoutRemainingWork > 0) {
    parts.push(`${lane.cardsWithoutRemainingWork} without an estimate`);
  }
  return parts.join(' · ');
}

function roundHours(hours: number): number {
  return Math.round(hours * 10) / 10;
}

/** What a screen reader hears when a card takes focus or is picked up. */
export function describeCard(card: BoardCard, columnName: string): string {
  const who = card.assignedTo?.displayName ?? 'Unassigned';
  return (
    `${card.type} ${card.workItemId}, ${card.title}, ` +
    `${who}, in ${columnName}`
  );
}
