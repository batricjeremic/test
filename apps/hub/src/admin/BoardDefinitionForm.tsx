/**
 * Name and default grouping of the saved board definition.
 *
 * The board is a saved definition, not an ad-hoc query, so this is where
 * its identity lives. `orgId` and `ownerDescriptor` are not editable:
 * they come from the Azure DevOps context the board was created in.
 */
import { BOARD_GROUPINGS, boardGroupingSchema } from '@eg/shared';
import type { AdminDraft } from './types';

export type BoardDefinitionFormProps = {
  readonly draft: AdminDraft;
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
};

export function BoardDefinitionForm({
  draft,
  update,
}: BoardDefinitionFormProps): JSX.Element {
  const { definition } = draft;

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-definition-heading"
    >
      <h2 id="eg-admin-definition-heading">Board</h2>
      <div className="eg-admin__grid">
        <label className="eg-admin__field">
          <span>Board name</span>
          <input
            type="text"
            value={definition.name}
            onChange={(event) =>
              update((current) => ({
                ...current,
                definition: { ...current.definition, name: event.target.value },
              }))
            }
          />
        </label>
        <label className="eg-admin__field">
          <span>Default grouping</span>
          <select
            value={definition.defaultGrouping}
            onChange={(event) => {
              const parsed = boardGroupingSchema.safeParse(event.target.value);
              if (!parsed.success) return;
              update((current) => ({
                ...current,
                definition: {
                  ...current.definition,
                  defaultGrouping: parsed.data,
                },
              }));
            }}
          >
            {BOARD_GROUPINGS.map((grouping) => (
              <option key={grouping} value={grouping}>
                {grouping === 'person'
                  ? 'One lane per person'
                  : 'One lane per team'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="eg-admin__hint">
        Anyone opening this board can switch grouping and filters for
        themselves; this only sets what they see first.
      </p>
    </section>
  );
}

export default BoardDefinitionForm;
