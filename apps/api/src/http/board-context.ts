/**
 * One board definition, resolved into the team boards it merges.
 *
 * Spec, "Domain model and column mapping": "To render one board we
 * resolve, per team, board id then column set then the mapping row." Both
 * the read path and the write path need exactly that, so it is built
 * once, here, from the config store plus cached Azure DevOps reads.
 */
import type {
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';
import type { AdoBoardReference } from '../ado/types.js';
import { NotFoundError } from '../errors.js';
import type { AreaPathIndex, TeamAreaPaths } from '../domain/index.js';
import {
  buildAreaPathIndex,
  buildMappingIndex,
  buildTeamBoardContext,
  teamAreaPathsFrom,
  type MappingIndex,
  type TeamBoardContext,
} from '../domain/index.js';
import type { CallOptions, ConfigStore } from '../ports.js';
import type { AdoReadDeps } from './ado-reads.js';
import {
  readBoard,
  readProjects,
  readTeamBoards,
  readTeamFieldValues,
  readTeams,
} from './ado-reads.js';

export interface BoardContextDeps extends AdoReadDeps {
  readonly config: ConfigStore;
}

/** One `BoardSource`, resolved. */
export interface BoardTeamEntry {
  readonly source: BoardSource;
  readonly team: TeamBoardContext;
  readonly areaPaths: TeamAreaPaths;
}

export interface BoardContext {
  readonly definition: BoardDefinition;
  readonly sources: readonly BoardSource[];
  readonly canonicalColumns: readonly CanonicalColumn[];
  readonly mappings: readonly ColumnMapping[];
  readonly overrides: readonly PersonOverride[];
  readonly entries: readonly BoardTeamEntry[];
  readonly index: MappingIndex;
  readonly areaPathIndex: AreaPathIndex;
  /** Distinct projects the board covers, in source order. */
  readonly projectIds: readonly string[];
}

/** The board, or a 404. A client-supplied board id is never trusted. */
export async function loadBoardDefinition(
  config: ConfigStore,
  boardId: string,
  options: CallOptions,
): Promise<BoardDefinition> {
  const definition = await config.getBoardDefinition(boardId, options);
  if (definition === null) {
    throw new NotFoundError(`Board ${boardId} does not exist`, {
      details: { boardId },
    });
  }
  return definition;
}

const sameName = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Which of the team's boards this source means. The backlog level is
 * matched on the board id first, then on its name, because Azure DevOps
 * names a team's board after the backlog level it renders.
 */
export function pickBoardReference(
  references: readonly AdoBoardReference[],
  backlogLevel: string,
  teamId: string,
): AdoBoardReference {
  const byId = references.find((entry) => entry.id === backlogLevel);
  if (byId !== undefined) return byId;
  const byName = references.find((entry) => sameName(entry.name, backlogLevel));
  if (byName !== undefined) return byName;
  const first = references[0];
  if (first === undefined) {
    throw new NotFoundError(`Team ${teamId} has no board`, {
      details: { teamId, backlogLevel },
    });
  }
  return first;
}

interface Directory {
  readonly projectNames: ReadonlyMap<string, string>;
  readonly teamNames: ReadonlyMap<string, string>;
}

/**
 * Display names for the projects and teams the board covers. Names are
 * for rendering only; every lookup elsewhere is by id.
 */
async function readDirectory(
  deps: BoardContextDeps,
  sources: readonly BoardSource[],
  options: CallOptions,
): Promise<Directory> {
  const projectNames = new Map<string, string>();
  const teamNames = new Map<string, string>();
  const projectIds = [...new Set(sources.map((entry) => entry.projectId))];
  const projects = await readProjects(deps, options);
  for (const projectId of projectIds) {
    const project = projects.find(
      (entry) => entry.id === projectId || sameName(entry.name, projectId),
    );
    projectNames.set(projectId, project?.name ?? projectId);
    const teams = await readTeams(deps, projectId, options);
    for (const team of teams) teamNames.set(team.id, team.name);
  }
  return { projectNames, teamNames };
}

async function loadEntry(
  deps: BoardContextDeps,
  source: BoardSource,
  directory: Directory,
  options: CallOptions,
): Promise<BoardTeamEntry> {
  const { projectId, teamId } = source;
  const references = await readTeamBoards(deps, projectId, teamId, options);
  const reference = pickBoardReference(
    references,
    source.backlogLevel,
    teamId,
  );
  const board = await readBoard(
    deps,
    projectId,
    teamId,
    reference.id,
    options,
  );
  const fieldValues = await readTeamFieldValues(
    deps,
    projectId,
    teamId,
    options,
  );
  return {
    source,
    team: buildTeamBoardContext({
      source,
      board,
      projectName: directory.projectNames.get(projectId) ?? projectId,
      teamName: directory.teamNames.get(teamId) ?? teamId,
    }),
    areaPaths: teamAreaPathsFrom(projectId, teamId, fieldValues),
  };
}

/**
 * The board's configuration and every team board it merges. Team reads
 * run in parallel; the ADO client's token bucket is what bounds them, so
 * a wide board cannot spend the interactive rate budget all at once.
 */
export async function loadBoardContext(
  deps: BoardContextDeps,
  definition: BoardDefinition,
  options: CallOptions,
): Promise<BoardContext> {
  const boardId = definition.id;
  const [sources, canonicalColumns, mappings, overrides] = await Promise.all([
    deps.config.listBoardSources(boardId, options),
    deps.config.listCanonicalColumns(boardId, options),
    deps.config.listColumnMappings(boardId, options),
    deps.config.listPersonOverrides(boardId, options),
  ]);

  const directory =
    sources.length === 0
      ? { projectNames: new Map(), teamNames: new Map() }
      : await readDirectory(deps, sources, options);

  const entries = await Promise.all(
    sources.map(async (source) =>
      loadEntry(deps, source, directory, options),
    ),
  );

  return {
    definition,
    sources,
    canonicalColumns,
    mappings,
    overrides,
    entries,
    index: buildMappingIndex({
      boardId,
      canonicalColumns,
      mappings,
      teams: entries.map((entry) => entry.team),
    }),
    areaPathIndex: buildAreaPathIndex(entries.map((entry) => entry.areaPaths)),
    projectIds: [...new Set(sources.map((entry) => entry.projectId))],
  };
}
