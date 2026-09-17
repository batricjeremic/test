/**
 * The set of team boards this board merges.
 *
 * Every board object in Azure DevOps is scoped to one team in one
 * project, so a cross-project board is exactly this list plus the
 * mapping below it. Removing a source also drops its mapping rows,
 * because a mapping for a team we no longer read is dead configuration.
 *
 * The three values are picked, never typed. They used to be typed, and
 * the first real board was configured by digging GUIDs out of Azure
 * DevOps URLs — a team id is shown nowhere in its UI. Worse, the backlog
 * level offered two hard-coded categories that `pickBoardReference` does
 * not match on, so a wrong value silently fell through to "the team's
 * first board" and looked like it had worked. The picker offers the
 * team's actual boards instead.
 *
 * When the directory cannot be reached the fields degrade to text inputs
 * rather than disappearing: a picker that fails must not take away the
 * only other way to configure a board.
 */
import { useEffect, useState } from 'react';
import type { BoardSource } from '@eg/shared';
import type { BoardApiClient } from '../api';
import { pruneMappings } from './model';
import type { AdminDraft } from './types';
import { useAdoDirectory } from './useAdoDirectory';

export type SourcesEditorProps = {
  readonly draft: AdminDraft;
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
  /** Overrides the client from `<ApiProvider>`. Tests inject the fake. */
  readonly client?: BoardApiClient;
};

type NewSource = { projectId: string; teamId: string; backlogLevel: string };

const EMPTY_SOURCE: NewSource = {
  projectId: '',
  teamId: '',
  backlogLevel: '',
};

export function SourcesEditor({
  draft,
  update,
  client,
}: SourcesEditorProps): JSX.Element {
  const [pending, setPending] = useState<NewSource>(EMPTY_SOURCE);
  const directory = useAdoDirectory(client);

  const teams = directory.teamsOf(pending.projectId);
  const boards = directory.boardsOf(pending.projectId, pending.teamId);

  // Ask for the next level down as soon as the one above is chosen, so
  // the dropdown is populated by the time it is reached.
  useEffect(() => {
    directory.loadTeams(pending.projectId);
  }, [directory, pending.projectId]);
  useEffect(() => {
    directory.loadBoards(pending.projectId, pending.teamId);
  }, [directory, pending.projectId, pending.teamId]);

  // Every team board is a valid answer, so default to the first rather
  // than making the admin choose a value they usually do not care about.
  useEffect(() => {
    if (pending.backlogLevel !== '' || boards === undefined) return;
    const first = boards[0];
    if (first)
      setPending((current) => ({ ...current, backlogLevel: first.id }));
  }, [boards, pending.backlogLevel]);

  const canAdd =
    pending.projectId.trim() !== '' &&
    pending.teamId.trim() !== '' &&
    pending.backlogLevel.trim() !== '';

  const addSource = (): void => {
    if (!canAdd) return;
    const source: BoardSource = {
      boardId: draft.definition.id,
      projectId: pending.projectId.trim(),
      teamId: pending.teamId.trim(),
      backlogLevel: pending.backlogLevel.trim(),
    };
    const duplicate = draft.sources.some(
      (candidate) =>
        candidate.projectId === source.projectId &&
        candidate.teamId === source.teamId,
    );
    if (duplicate) return;
    update((current) => ({
      ...current,
      sources: [...current.sources, source],
    }));
    setPending(EMPTY_SOURCE);
  };

  const removeSource = (source: BoardSource): void => {
    update((current) => {
      const sources = current.sources.filter(
        (candidate) =>
          candidate.projectId !== source.projectId ||
          candidate.teamId !== source.teamId ||
          candidate.backlogLevel !== source.backlogLevel,
      );
      return {
        ...current,
        sources,
        mappings: pruneMappings(current.mappings, sources, current.columns),
      };
    });
  };

  const boardName = (source: BoardSource): string =>
    directory
      .boardsOf(source.projectId, source.teamId)
      ?.find((board) => board.id === source.backlogLevel)?.name ??
    source.backlogLevel;

  const degraded = directory.status === 'error';

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-sources-heading"
    >
      <h2 id="eg-admin-sources-heading">Source team boards</h2>
      <p className="eg-admin__hint">
        One row per team board merged into this board. A team belongs to exactly
        one project, so a team can never appear under two projects.
      </p>
      {degraded ? (
        <p className="eg-admin__warning" role="status">
          Could not read the list of projects, so these are plain text fields.
          They take the project and team <strong>ids</strong> — a team id is in
          the URL of that team&rsquo;s page in Azure DevOps.
        </p>
      ) : null}
      <table className="eg-admin__table">
        <caption>Team boards merged into this board</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Team</th>
            <th scope="col">Board</th>
            <th scope="col">
              <span className="eg-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.sources.length === 0 ? (
            <tr>
              <td colSpan={4}>
                No source yet. A board with no sources shows nothing.
              </td>
            </tr>
          ) : (
            draft.sources.map((source) => (
              <tr
                key={`${source.projectId}/${source.teamId}/${source.backlogLevel}`}
              >
                <td>{directory.projectName(source.projectId)}</td>
                <th scope="row">
                  {directory.teamName(source.projectId, source.teamId)}
                </th>
                <td>{boardName(source)}</td>
                <td>
                  <button
                    type="button"
                    className="eg-button"
                    onClick={() => removeSource(source)}
                  >
                    {`Remove ${directory.teamName(source.projectId, source.teamId)}`}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>
              <label className="eg-admin__field">
                <span>Project</span>
                {degraded ? (
                  <input
                    type="text"
                    value={pending.projectId}
                    onChange={(event) =>
                      setPending({
                        projectId: event.target.value,
                        teamId: '',
                        backlogLevel: '',
                      })
                    }
                  />
                ) : (
                  <select
                    value={pending.projectId}
                    onChange={(event) =>
                      setPending({
                        projectId: event.target.value,
                        teamId: '',
                        backlogLevel: '',
                      })
                    }
                  >
                    <option value="">
                      {directory.status === 'loading'
                        ? 'Loading…'
                        : 'Choose a project'}
                    </option>
                    {directory.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </td>
            <td>
              <label className="eg-admin__field">
                <span>Team</span>
                {degraded ||
                (pending.projectId !== '' && teams === undefined) ? (
                  <input
                    type="text"
                    value={pending.teamId}
                    onChange={(event) =>
                      setPending((current) => ({
                        ...current,
                        teamId: event.target.value,
                        backlogLevel: '',
                      }))
                    }
                  />
                ) : (
                  <select
                    value={pending.teamId}
                    disabled={pending.projectId === ''}
                    onChange={(event) =>
                      setPending((current) => ({
                        ...current,
                        teamId: event.target.value,
                        backlogLevel: '',
                      }))
                    }
                  >
                    <option value="">
                      {pending.projectId === ''
                        ? 'Choose a project first'
                        : 'Choose a team'}
                    </option>
                    {(teams ?? []).map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </td>
            <td>
              <label className="eg-admin__field">
                <span>Board</span>
                {degraded || (pending.teamId !== '' && boards === undefined) ? (
                  <input
                    type="text"
                    value={pending.backlogLevel}
                    onChange={(event) =>
                      setPending((current) => ({
                        ...current,
                        backlogLevel: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <select
                    value={pending.backlogLevel}
                    disabled={pending.teamId === ''}
                    onChange={(event) =>
                      setPending((current) => ({
                        ...current,
                        backlogLevel: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {pending.teamId === ''
                        ? 'Choose a team first'
                        : 'Choose a board'}
                    </option>
                    {(boards ?? []).map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </td>
            <td>
              <button
                type="button"
                className="eg-button eg-button--primary"
                disabled={!canAdd}
                onClick={addSource}
              >
                Add source
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

export default SourcesEditor;
