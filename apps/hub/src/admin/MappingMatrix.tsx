/**
 * The mapping matrix: every team's own board columns against the
 * canonical ones.
 *
 * Two teams may both have a column called "In Review" that means
 * different things, and different columns that mean the same thing. The
 * only way to see that is to see the whole reconciliation at once, so
 * this is one table: a row group per team, a column per canonical
 * column, one radio per cell.
 */
import { useState } from 'react';
import type { CanonicalColumn } from '@eg/shared';
import { findMapping, setMapping, setTargetState, sortColumns } from './model';
import type { AdminDraft, AdminTeam } from './types';

export type MappingMatrixProps = {
  readonly draft: AdminDraft;
  readonly teams: readonly AdminTeam[];
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
  readonly addTeamColumn: (teamId: string, sourceColumnId: string) => void;
};

type AddColumnRowProps = {
  readonly team: AdminTeam;
  readonly span: number;
  readonly onAdd: (teamId: string, sourceColumnId: string) => void;
};

function AddColumnRow({ team, span, onAdd }: AddColumnRowProps): JSX.Element {
  const [name, setName] = useState('');
  const label = `Add a column of ${team.teamName}`;

  return (
    <tr>
      <td colSpan={span}>
        <div className="eg-row">
          <label className="eg-admin__field">
            <span>{label}</span>
            <input
              type="text"
              value={name}
              aria-label={label}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="eg-button"
            disabled={name.trim() === ''}
            onClick={() => {
              onAdd(team.teamId, name);
              setName('');
            }}
          >
            Add column
          </button>
        </div>
      </td>
    </tr>
  );
}

export function MappingMatrix({
  draft,
  teams,
  update,
  addTeamColumn,
}: MappingMatrixProps): JSX.Element {
  const columns: readonly CanonicalColumn[] = sortColumns(draft.columns);
  const span = columns.length + 4;

  const onMap = (
    teamId: string,
    sourceColumnId: string,
    canonicalColumnId: string | null,
  ): void => {
    update((current) => ({
      ...current,
      mappings: setMapping(
        current.mappings,
        current.definition.id,
        teamId,
        sourceColumnId,
        canonicalColumnId,
      ),
    }));
  };

  const onTargetState = (
    teamId: string,
    sourceColumnId: string,
    value: string,
  ): void => {
    update((current) => ({
      ...current,
      mappings: setTargetState(current.mappings, teamId, sourceColumnId, value),
    }));
  };

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-mapping-heading"
    >
      <h2 id="eg-admin-mapping-heading">Column mapping</h2>
      <p className="eg-admin__hint">
        Each team&rsquo;s board has its own columns. Point every one of them at
        a canonical column. A team column left unmapped is not guessed: its
        cards land in the Unmapped lane.
      </p>
      <p className="eg-admin__hint">
        <strong>Target state</strong> is optional. Leave it empty and a move
        into that column writes the board column alone, exactly as a native
        board behaves when a column is not bound to a state. Fill it in and the
        move writes the board column and <code>System.State</code> in one patch,
        so the two can never diverge.
      </p>
      <div className="eg-admin__matrix-scroll">
        <table className="eg-admin__table">
          <caption>
            Team board columns mapped onto this board&rsquo;s canonical columns
          </caption>
          <thead>
            <tr>
              <th scope="col">Team column</th>
              <th scope="col">Cards</th>
              <th scope="col">Not mapped</th>
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.name}
                </th>
              ))}
              <th scope="col">Target state</th>
            </tr>
          </thead>
          {teams.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={span}>
                  Add a source team board above and its columns appear here.
                </td>
              </tr>
            </tbody>
          ) : (
            teams.map((team) => (
              <tbody key={team.teamId}>
                <tr className="eg-admin__team-row">
                  <th scope="rowgroup" colSpan={span}>
                    {`${team.projectName} · ${team.teamName}`}
                  </th>
                </tr>
                {team.columns.map((teamColumn) => {
                  const mapping = findMapping(
                    draft.mappings,
                    team.teamId,
                    teamColumn.sourceColumnId,
                  );
                  const group = `map:${team.teamId}:${teamColumn.sourceColumnId}`;
                  const rowLabel = `${teamColumn.sourceColumnId} on ${team.teamName}`;
                  return (
                    <tr
                      key={teamColumn.sourceColumnId}
                      className={
                        mapping === null ? 'eg-admin__row-unmapped' : undefined
                      }
                    >
                      <th scope="row">{teamColumn.sourceColumnId}</th>
                      <td>{teamColumn.cardCount}</td>
                      <td
                        className="eg-admin__cell-radio"
                        data-mapped={mapping === null ? 'true' : 'false'}
                      >
                        <input
                          type="radio"
                          name={group}
                          checked={mapping === null}
                          aria-label={`Leave ${rowLabel} unmapped`}
                          onChange={() =>
                            onMap(team.teamId, teamColumn.sourceColumnId, null)
                          }
                        />
                      </td>
                      {columns.map((column) => (
                        <td
                          key={column.id}
                          className="eg-admin__cell-radio"
                          data-mapped={
                            mapping?.canonicalColumnId === column.id
                              ? 'true'
                              : 'false'
                          }
                        >
                          <input
                            type="radio"
                            name={group}
                            checked={mapping?.canonicalColumnId === column.id}
                            aria-label={`Map ${rowLabel} to ${column.name}`}
                            onChange={() =>
                              onMap(
                                team.teamId,
                                teamColumn.sourceColumnId,
                                column.id,
                              )
                            }
                          />
                        </td>
                      ))}
                      <td>
                        <input
                          type="text"
                          value={mapping?.targetState ?? ''}
                          disabled={mapping === null}
                          placeholder="Column moves alone"
                          aria-label={`Target state for ${rowLabel}`}
                          onChange={(event) =>
                            onTargetState(
                              team.teamId,
                              teamColumn.sourceColumnId,
                              event.target.value,
                            )
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
                <AddColumnRow team={team} span={span} onAdd={addTeamColumn} />
              </tbody>
            ))
          )}
        </table>
      </div>
    </section>
  );
}

export default MappingMatrix;
