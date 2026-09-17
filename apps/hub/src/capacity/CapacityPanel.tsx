/**
 * The fuller capacity view: every person in scope, heaviest first.
 *
 * Purely presentational — it takes the `personLoad` array the snapshot
 * already carries, so it can be rendered from the board, from a side
 * panel, or from a test without a provider in sight.
 */
import type { PersonLoad } from '@eg/shared';
import { PersonCapacity } from './PersonCapacity';
import { countPeopleWithOutOfScopeTeams, sortPeopleByLoad } from './load';
import './capacity.css';

export type CapacityPanelProps = {
  readonly people: readonly PersonLoad[];
  readonly threshold?: number;
  readonly title?: string;
};

/** Capacity and remaining work per person, rolled up across their teams. */
export function CapacityPanel({
  people,
  threshold,
  title = 'Capacity this window',
}: CapacityPanelProps): JSX.Element {
  const visible = sortPeopleByLoad(people);
  const outOfScopeCount = countPeopleWithOutOfScopeTeams(visible);

  return (
    <section className="eg-panel eg-capacity-panel" aria-label={title}>
      <h2>{title}</h2>
      {visible.length === 0 ? (
        <p className="eg-capacity-panel__empty">
          Nobody in this board&rsquo;s scope has work in the selected window.
        </p>
      ) : (
        <ul className="eg-capacity-panel__list">
          {visible.map((person) => (
            <li key={person.descriptor} className="eg-capacity-panel__person">
              <PersonCapacity
                person={person}
                variant="summary"
                threshold={threshold}
              />
            </li>
          ))}
        </ul>
      )}
      {outOfScopeCount > 0 ? (
        <p className="eg-capacity-panel__footnote">
          {`† ${outOfScopeCount} ${
            outOfScopeCount === 1 ? 'person is' : 'people are'
          } also on teams outside this board, so their bars are not their whole load.`}
        </p>
      ) : null}
    </section>
  );
}

export default CapacityPanel;
