/**
 * The headline of the admin screen: how many team columns are unmapped.
 *
 * Unmapped columns are never guessed. Cards in them land in the Unmapped
 * lane with their team and column named, which is honest but useless as
 * a working board — so this count is the number the screen exists to
 * drive to zero.
 */
import type { TeamColumnRef } from './types';

export type UnmappedPanelProps = {
  readonly unmapped: readonly TeamColumnRef[];
};

export function UnmappedPanel({ unmapped }: UnmappedPanelProps): JSX.Element {
  const clear = unmapped.length === 0;
  const strandedCards = unmapped.reduce(
    (total, column) => total + column.cardCount,
    0,
  );

  return (
    <section
      className="eg-panel eg-admin__section eg-admin__unmapped"
      aria-labelledby="eg-admin-unmapped-heading"
      data-clear={clear ? 'true' : 'false'}
    >
      <h2 id="eg-admin-unmapped-heading">Unmapped team columns</h2>
      <p className="eg-admin__count" data-testid="unmapped-count">
        {unmapped.length}
      </p>
      {clear ? (
        <p className="eg-admin__hint">
          Every team column on this board maps to a canonical column. No card
          can land in the Unmapped lane.
        </p>
      ) : (
        <>
          <p className="eg-admin__hint">
            {unmapped.length === 1
              ? '1 team column has no mapping row.'
              : `${unmapped.length} team columns have no mapping row.`}{' '}
            Cards sitting in them are shown in the Unmapped lane with their team
            and column named, rather than being placed in a column that might be
            wrong.
            {strandedCards > 0
              ? ` ${strandedCards} ${
                  strandedCards === 1 ? 'card is' : 'cards are'
                } there right now.`
              : ''}
          </p>
          <ul className="eg-admin__unmapped-list">
            {unmapped.map((column) => (
              <li key={`${column.teamId}:${column.sourceColumnId}`}>
                <strong>{column.sourceColumnId}</strong>
                <span>
                  {column.teamName === ''
                    ? column.teamId
                    : `${column.projectName} · ${column.teamName}`}
                </span>
                <span>
                  {column.cardCount === 1
                    ? '1 card stranded'
                    : `${column.cardCount} cards stranded`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default UnmappedPanel;
