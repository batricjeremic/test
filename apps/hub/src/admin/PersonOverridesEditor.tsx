/**
 * Person overrides: display tidying for contractors and shared accounts.
 *
 * Identity already resolves consistently: within one Azure DevOps
 * organization `System.AssignedTo` returns the same descriptor in every
 * project, so one person is already one swimlane. Nothing here affects
 * which cards land where — it only changes a label, or hides a lane that
 * is a build service rather than a person.
 */
import { useState } from 'react';
import type { PersonOverride } from '@eg/shared';
import type { AdminDraft } from './types';

export type PersonOverridesEditorProps = {
  readonly draft: AdminDraft;
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
};

export function PersonOverridesEditor({
  draft,
  update,
}: PersonOverridesEditorProps): JSX.Element {
  const [descriptor, setDescriptor] = useState('');

  const addOverride = (): void => {
    const trimmed = descriptor.trim();
    if (trimmed === '') return;
    const override: PersonOverride = {
      boardId: draft.definition.id,
      descriptor: trimmed,
      displayName: '',
      hidden: false,
    };
    update((current) =>
      current.overrides.some((entry) => entry.descriptor === trimmed)
        ? current
        : { ...current, overrides: [...current.overrides, override] },
    );
    setDescriptor('');
  };

  const patchOverride = (
    target: string,
    patch: Partial<PersonOverride>,
  ): void => {
    update((current) => ({
      ...current,
      overrides: current.overrides.map((entry) =>
        entry.descriptor === target ? { ...entry, ...patch } : entry,
      ),
    }));
  };

  const removeOverride = (target: string): void => {
    update((current) => ({
      ...current,
      overrides: current.overrides.filter(
        (entry) => entry.descriptor !== target,
      ),
    }));
  };

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-overrides-heading"
    >
      <h2 id="eg-admin-overrides-heading">Person overrides</h2>
      <p className="eg-admin__hint">
        Display tidying only, never correctness. A person already maps to one
        lane across every project in this organisation; this renames that lane
        or hides it when it is a shared account rather than a person. Hiding
        somebody does not hide their cards from anyone who can see them in Azure
        Boards.
      </p>
      <table className="eg-admin__table">
        <caption>Overrides applied to lane labels</caption>
        <thead>
          <tr>
            <th scope="col">Identity descriptor</th>
            <th scope="col">Display name</th>
            <th scope="col">Hidden</th>
            <th scope="col">
              <span className="eg-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.overrides.length === 0 ? (
            <tr>
              <td colSpan={4}>
                No overrides. Every lane is labelled the way Azure DevOps labels
                it.
              </td>
            </tr>
          ) : (
            draft.overrides.map((override) => (
              <tr key={override.descriptor}>
                <th scope="row">{override.descriptor}</th>
                <td>
                  <input
                    type="text"
                    value={override.displayName}
                    aria-label={`Display name for ${override.descriptor}`}
                    onChange={(event) =>
                      patchOverride(override.descriptor, {
                        displayName: event.target.value,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={override.hidden}
                    aria-label={`Hide ${override.descriptor}`}
                    onChange={(event) =>
                      patchOverride(override.descriptor, {
                        hidden: event.target.checked,
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="eg-button"
                    aria-label={`Remove the override for ${override.descriptor}`}
                    onClick={() => removeOverride(override.descriptor)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="eg-row">
        <label className="eg-admin__field">
          <span>New identity descriptor</span>
          <input
            type="text"
            value={descriptor}
            aria-label="New identity descriptor"
            onChange={(event) => setDescriptor(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="eg-button"
          disabled={descriptor.trim() === ''}
          onClick={addOverride}
        >
          Add override
        </button>
      </div>
    </section>
  );
}

export default PersonOverridesEditor;
