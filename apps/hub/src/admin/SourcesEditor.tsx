/**
 * The set of team boards this board merges.
 *
 * Every board object in Azure DevOps is scoped to one team in one
 * project, so a cross-project board is exactly this list plus the
 * mapping below it. Removing a source also drops its mapping rows,
 * because a mapping for a team we no longer read is dead configuration.
 */
import { useState } from 'react';
import type { BoardSource } from '@eg/shared';
import { pruneMappings } from './model';
import type { AdminDraft } from './types';

/** The two backlog levels a sprint board is ever built from. */
const BACKLOG_LEVELS = [
  'Microsoft.RequirementCategory',
  'Microsoft.TaskCategory',
] as const;

export type SourcesEditorProps = {
  readonly draft: AdminDraft;
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
};

type NewSource = { projectId: string; teamId: string; backlogLevel: string };

const EMPTY_SOURCE: NewSource = {
  projectId: '',
  teamId: '',
  backlogLevel: BACKLOG_LEVELS[0],
};

export function SourcesEditor({
  draft,
  update,
}: SourcesEditorProps): JSX.Element {
  const [pending, setPending] = useState<NewSource>(EMPTY_SOURCE);

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
      <table className="eg-admin__table">
        <caption>Team boards merged into this board</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Team</th>
            <th scope="col">Backlog level</th>
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
                <td>{source.projectId}</td>
                <th scope="row">{source.teamId}</th>
                <td>{source.backlogLevel}</td>
                <td>
                  <button
                    type="button"
                    className="eg-button"
                    onClick={() => removeSource(source)}
                  >
                    {`Remove ${source.teamId}`}
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
                <span>New project id</span>
                <input
                  type="text"
                  value={pending.projectId}
                  onChange={(event) =>
                    setPending((current) => ({
                      ...current,
                      projectId: event.target.value,
                    }))
                  }
                />
              </label>
            </td>
            <td>
              <label className="eg-admin__field">
                <span>New team id</span>
                <input
                  type="text"
                  value={pending.teamId}
                  onChange={(event) =>
                    setPending((current) => ({
                      ...current,
                      teamId: event.target.value,
                    }))
                  }
                />
              </label>
            </td>
            <td>
              <label className="eg-admin__field">
                <span>New backlog level</span>
                <select
                  value={pending.backlogLevel}
                  onChange={(event) =>
                    setPending((current) => ({
                      ...current,
                      backlogLevel: event.target.value,
                    }))
                  }
                >
                  {BACKLOG_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
            </td>
            <td>
              <button
                type="button"
                className="eg-button"
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
