/**
 * Iteration alignment — the spec's three modes.
 *
 * Spec: "Iteration alignment". If teams run different cadences, "this
 * sprint" is not one thing, so the choice is explicit: each team's
 * current sprint (the default), a date window teams' iterations overlap,
 * or one named iteration path shared across teams.
 *
 * Each mode resolves, per team, which iterations are in scope, and
 * carries that team's own sprint dates through so a swimlane can say
 * "day 2 of 15". Burndown is reported as suppressed when the windows do
 * not line up, because a burndown over mismatched windows is a lie.
 */
import type {
  BurndownAvailability,
  IterationAlignment,
  TeamIterationWindow,
} from '@eg/shared';
import type { AdoTeamSettingsIteration } from '../ado/types.js';
import type { Clock } from '../ports.js';
import type { TeamBoardContext } from './mapping.js';
import { compareStrings } from './sorting.js';
import type { EpochDay, Weekday } from './working-days.js';
import {
  countWorkingDays,
  epochDayOf,
  isoTimestampOfEpochDay,
  parseEpochDay,
  rangesOverlap,
  toWorkingDaySet,
} from './working-days.js';

/** One team's iterations plus the working-days setting they run on. */
export interface TeamIterationInput {
  readonly team: TeamBoardContext;
  readonly iterations: readonly AdoTeamSettingsIteration[];
  /** The team's own working days. Defaults to Monday–Friday. */
  readonly workingDays?: readonly Weekday[];
}

/** An iteration that is in scope for this window, with its maths done. */
export interface ResolvedTeamIteration {
  readonly window: TeamIterationWindow;
  readonly startDay: EpochDay | null;
  readonly endDay: EpochDay | null;
  readonly workingDays: ReadonlySet<Weekday>;
  readonly iteration: AdoTeamSettingsIteration;
}

/** Everything in scope for one team, and which one the team badge shows. */
export interface TeamIterationScope {
  readonly team: TeamBoardContext;
  /** In scope for this alignment, ascending by start date then id. */
  readonly iterations: readonly ResolvedTeamIteration[];
  /** The one a `BoardTeamView` carries; null when nothing is in scope. */
  readonly primary: ResolvedTeamIteration | null;
}

/** Iteration paths compare like area paths: slashes and case are noise. */
export function normalizeIterationPath(value: string): string {
  return value
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .toLowerCase();
}

function toWindow(
  team: TeamBoardContext,
  iteration: AdoTeamSettingsIteration,
  workingDays: ReadonlySet<Weekday>,
  today: EpochDay,
): ResolvedTeamIteration {
  const startDay = parseEpochDay(iteration.attributes?.startDate ?? null);
  const endDay = parseEpochDay(iteration.attributes?.finishDate ?? null);
  const workingDaysTotal = countWorkingDays(startDay, endDay, workingDays);
  const elapsedEnd =
    startDay === null || endDay === null ? null : Math.min(today, endDay);
  const workingDaysElapsed = Math.min(
    workingDaysTotal,
    countWorkingDays(startDay, elapsedEnd, workingDays),
  );

  const window: TeamIterationWindow = {
    projectId: team.projectId,
    projectName: team.projectName,
    teamId: team.teamId,
    teamName: team.teamName,
    iterationId: iteration.id,
    iterationPath: iteration.path,
    iterationName: iteration.name,
    startDate: startDay === null ? null : isoTimestampOfEpochDay(startDay),
    finishDate: endDay === null ? null : isoTimestampOfEpochDay(endDay),
    workingDaysTotal,
    workingDaysElapsed,
  };

  return { window, startDay, endDay, workingDays, iteration };
}

function byStartThenId(
  a: ResolvedTeamIteration,
  b: ResolvedTeamIteration,
): number {
  const left = a.startDay ?? Number.MAX_SAFE_INTEGER;
  const right = b.startDay ?? Number.MAX_SAFE_INTEGER;
  return (
    left - right || compareStrings(a.window.iterationId, b.window.iterationId)
  );
}

/**
 * Which of this team's iterations the selected alignment puts in scope.
 *
 * - `each-team-current` takes the iteration the service marks `current`,
 *   falling back to the one containing today, and nothing if neither
 *   exists: a team with no current sprint contributes no cards rather
 *   than an arbitrary one.
 * - `date-window` takes every iteration overlapping the range. An
 *   iteration with no dates cannot be known to overlap, so it is out.
 * - `named-iteration` takes the iteration whose path matches, and falls
 *   back to a name match for teams that spell the path differently.
 */
export function resolveTeamIterationScope(
  input: TeamIterationInput,
  alignment: IterationAlignment,
  clock: Clock,
): TeamIterationScope {
  const workingDays = toWorkingDaySet(input.workingDays);
  const today = epochDayOf(clock.now());
  const resolved = input.iterations.map((iteration) =>
    toWindow(input.team, iteration, workingDays, today),
  );

  let inScope: ResolvedTeamIteration[];
  switch (alignment.mode) {
    case 'each-team-current': {
      const marked = resolved.filter(
        (entry) => entry.iteration.attributes?.timeFrame === 'current',
      );
      const containing = resolved.filter(
        (entry) =>
          entry.startDay !== null &&
          entry.endDay !== null &&
          entry.startDay <= today &&
          today <= entry.endDay,
      );
      const candidates = marked.length > 0 ? marked : containing;
      inScope = candidates.sort(byStartThenId).slice(0, 1);
      break;
    }
    case 'date-window': {
      const start = parseEpochDay(alignment.window.start);
      const end = parseEpochDay(alignment.window.end);
      if (start === null || end === null) {
        inScope = [];
        break;
      }
      inScope = resolved
        .filter((entry) =>
          rangesOverlap(
            { start: entry.startDay, end: entry.endDay },
            { start, end },
          ),
        )
        .sort(byStartThenId);
      break;
    }
    case 'named-iteration': {
      const wanted = normalizeIterationPath(alignment.iterationPath);
      const byPath = resolved.filter(
        (entry) =>
          normalizeIterationPath(entry.window.iterationPath) === wanted,
      );
      const byName =
        byPath.length > 0
          ? byPath
          : resolved.filter(
              (entry) =>
                normalizeIterationPath(entry.window.iterationName) === wanted,
            );
      inScope = byName.sort(byStartThenId).slice(0, 1);
      break;
    }
  }

  return {
    team: input.team,
    iterations: inScope,
    primary: inScope[0] ?? null,
  };
}

/** The same resolution for every team on the board, in input order. */
export function resolveTeamIterationScopes(
  inputs: readonly TeamIterationInput[],
  alignment: IterationAlignment,
  clock: Clock,
): TeamIterationScope[] {
  return inputs.map((input) =>
    resolveTeamIterationScope(input, alignment, clock),
  );
}

/**
 * Burndown is only honest when every team is looking at the same window.
 * Any team with a second iteration in scope, or with dates that differ
 * from another team's, suppresses it.
 */
export function resolveBurndownAvailability(
  scopes: readonly TeamIterationScope[],
): BurndownAvailability {
  const withPrimary = scopes.filter((scope) => scope.primary !== null);
  if (withPrimary.length === 0) return 'suppressed-mismatched-windows';
  if (scopes.some((scope) => scope.iterations.length > 1)) {
    return 'suppressed-mismatched-windows';
  }

  const first = withPrimary[0]?.primary?.window;
  if (first === undefined) return 'suppressed-mismatched-windows';
  if (first.startDate === null || first.finishDate === null) {
    return 'suppressed-mismatched-windows';
  }

  const aligned = withPrimary.every((scope) => {
    const window = scope.primary?.window;
    return (
      window !== undefined &&
      window.startDate === first.startDate &&
      window.finishDate === first.finishDate
    );
  });
  return aligned ? 'available' : 'suppressed-mismatched-windows';
}

/** The iteration ids one team has in scope, for matching work item sets. */
export function inScopeIterationIds(
  scope: TeamIterationScope,
): ReadonlySet<string> {
  return new Set(scope.iterations.map((entry) => entry.window.iterationId));
}
