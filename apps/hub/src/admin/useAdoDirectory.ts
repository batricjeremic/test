/**
 * The projects, teams and team boards the source picker offers.
 *
 * This exists because the first real board was configured by pasting
 * GUIDs out of Azure DevOps URLs. A team id appears nowhere on screen in
 * Azure DevOps, and a mistyped one does not fail at the point of typing —
 * it fails much later, as an empty board.
 *
 * Teams and boards load lazily, one project at a time, so opening the
 * screen costs a single call rather than one per project. Everything is
 * cached for the life of the screen: an admin moves back and forth
 * between projects while deciding, and re-reading on every keystroke
 * would spend the organisation's rate-limit budget on a dropdown.
 *
 * A failure here is not fatal. `error` is reported so the editor can fall
 * back to plain text fields, because a picker that cannot load must not
 * take away the only other way to configure a board.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdoProjectRef, AdoTeamBoardRef, AdoTeamRef } from '@eg/shared';
import { describeApiError, useOptionalApiClient } from '../api';
import type { BoardApiClient } from '../api';

export type AdoDirectory = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly projects: readonly AdoProjectRef[];
  /** Teams of one project, once it has been asked for. */
  teamsOf(projectId: string): readonly AdoTeamRef[] | undefined;
  boardsOf(
    projectId: string,
    teamId: string,
  ): readonly AdoTeamBoardRef[] | undefined;
  /** Idempotent: asking twice does not call twice. */
  loadTeams(projectId: string): void;
  loadBoards(projectId: string, teamId: string): void;
  /** Display name for an id already in the directory, or the id itself. */
  projectName(projectId: string): string;
  teamName(projectId: string, teamId: string): string;
};

const teamKey = (projectId: string, teamId: string): string =>
  `${projectId}/${teamId}`;

export function useAdoDirectory(injected?: BoardApiClient): AdoDirectory {
  const fallback = useOptionalApiClient();
  const client = injected ?? fallback;

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly AdoProjectRef[]>([]);
  const [teams, setTeams] = useState<Record<string, readonly AdoTeamRef[]>>({});
  const [boards, setBoards] = useState<
    Record<string, readonly AdoTeamBoardRef[]>
  >({});
  // Requests in flight, so a re-render cannot fire the same call twice.
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (client === null) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const found = await client.listAdoProjects();
        if (cancelled) return;
        setProjects(found);
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setError(describeApiError(cause));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const loadTeams = useCallback(
    (projectId: string) => {
      const key = `teams:${projectId}`;
      if (client === null || projectId === '' || asked.current.has(key)) return;
      asked.current.add(key);
      void (async () => {
        try {
          const found = await client.listAdoTeams(projectId);
          setTeams((current) => ({ ...current, [projectId]: found }));
        } catch {
          // Leave it absent: the editor falls back to a text field for
          // this project rather than showing an empty dropdown that
          // looks like "this project has no teams".
          asked.current.delete(key);
        }
      })();
    },
    [client],
  );

  const loadBoards = useCallback(
    (projectId: string, teamId: string) => {
      const key = `boards:${teamKey(projectId, teamId)}`;
      if (
        client === null ||
        projectId === '' ||
        teamId === '' ||
        asked.current.has(key)
      )
        return;
      asked.current.add(key);
      void (async () => {
        try {
          const found = await client.listAdoTeamBoards(projectId, teamId);
          setBoards((current) => ({
            ...current,
            [teamKey(projectId, teamId)]: found,
          }));
        } catch {
          asked.current.delete(key);
        }
      })();
    },
    [client],
  );

  return {
    status,
    error,
    projects,
    teamsOf: (projectId) => teams[projectId],
    boardsOf: (projectId, teamId) => boards[teamKey(projectId, teamId)],
    loadTeams,
    loadBoards,
    projectName: (projectId) =>
      projects.find((project) => project.id === projectId)?.name ?? projectId,
    teamName: (projectId, teamId) =>
      teams[projectId]?.find((team) => team.id === teamId)?.name ?? teamId,
  };
}
