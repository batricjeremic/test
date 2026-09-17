/**
 * Owning-team resolution from a work item's area path.
 *
 * Spec: `BoardCard.teamId` is the "owning team, resolved from area path",
 * and "every write is team-scoped ... that resolution has to be correct
 * on the first try, because a wrong team id fails the call outright".
 *
 * A team subscribes to one or more area paths, each with an
 * `includeChildren` flag. The most specific subscription wins, so a
 * sub-team that owns `Delivery\Web\Checkout` takes its cards back from
 * the parent team that owns `Delivery\Web` with children included.
 */
import type { AdoTeamFieldValues } from '../ado/types.js';
import { compareStrings } from './sorting.js';

export interface TeamAreaPath {
  readonly value: string;
  readonly includeChildren: boolean;
}

export interface TeamAreaPaths {
  readonly projectId: string;
  readonly teamId: string;
  readonly areaPaths: readonly TeamAreaPath[];
}

/** Reads the team-field values response into the shape the index wants. */
export function teamAreaPathsFrom(
  projectId: string,
  teamId: string,
  values: AdoTeamFieldValues,
): TeamAreaPaths {
  return {
    projectId,
    teamId,
    areaPaths: values.values.map((entry) => ({
      value: entry.value,
      includeChildren: entry.includeChildren,
    })),
  };
}

/**
 * Area paths are compared with forward and back slashes treated alike,
 * trailing separators dropped and case ignored, because Azure DevOps
 * accepts all of those spellings for the same node.
 */
export function normalizeAreaPath(value: string): string {
  return value
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .toLowerCase();
}

interface AreaPathEntry {
  readonly projectId: string;
  readonly teamId: string;
  readonly path: string;
  readonly includeChildren: boolean;
}

export interface AreaPathIndex {
  readonly entries: readonly AreaPathEntry[];
}

/** Builds the index once per snapshot; resolution is then a scan of it. */
export function buildAreaPathIndex(
  teams: readonly TeamAreaPaths[],
): AreaPathIndex {
  const entries: AreaPathEntry[] = [];
  for (const team of teams) {
    for (const areaPath of team.areaPaths) {
      const path = normalizeAreaPath(areaPath.value);
      if (path.length === 0) continue;
      entries.push({
        projectId: team.projectId,
        teamId: team.teamId,
        path,
        includeChildren: areaPath.includeChildren,
      });
    }
  }
  return { entries };
}

/**
 * The team that owns this area path, or null when no team in the index
 * claims it. An exact subscription always beats an inherited one, then
 * the longest path wins, then the team id, so the answer never depends on
 * input order.
 */
export function resolveOwningTeamId(
  index: AreaPathIndex,
  projectId: string,
  areaPath: string | null,
): string | null {
  if (areaPath === null) return null;
  const path = normalizeAreaPath(areaPath);
  if (path.length === 0) return null;

  let best: { entry: AreaPathEntry; exact: boolean } | null = null;
  for (const entry of index.entries) {
    if (entry.projectId !== projectId) continue;
    const exact = entry.path === path;
    const inherited =
      entry.includeChildren && path.startsWith(`${entry.path}\\`);
    if (!exact && !inherited) continue;
    if (best === null) {
      best = { entry, exact };
      continue;
    }
    if (exact !== best.exact) {
      if (exact) best = { entry, exact };
      continue;
    }
    const byLength = entry.path.length - best.entry.path.length;
    if (byLength > 0) {
      best = { entry, exact };
      continue;
    }
    if (byLength === 0 && compareStrings(entry.teamId, best.entry.teamId) < 0) {
      best = { entry, exact };
    }
  }

  return best?.entry.teamId ?? null;
}
