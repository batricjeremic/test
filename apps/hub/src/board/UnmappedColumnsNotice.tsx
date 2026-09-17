/**
 * The unmapped lane's explanation.
 *
 * A card whose team column has no mapping row is never guessed into a
 * column: it lands in the visible "Unmapped" column, and this names the
 * team and the column it came from so an admin can fix the mapping.
 */
import type { UnmappedColumnRef } from '@eg/shared';

export type UnmappedColumnsNoticeProps = {
  unmappedColumns: readonly UnmappedColumnRef[];
};

export function UnmappedColumnsNotice({
  unmappedColumns,
}: UnmappedColumnsNoticeProps): JSX.Element | null {
  if (unmappedColumns.length === 0) return null;

  return (
    <section className="eg-panel eg-notice" aria-label="Unmapped columns">
      <strong>
        {unmappedColumns.length} team column
        {unmappedColumns.length === 1 ? '' : 's'} have no mapping
      </strong>
      <p className="eg-lane__meta">
        Their cards sit in the Unmapped column rather than being guessed into
        one. An admin can map them on the board settings screen.
      </p>
      <ul>
        {unmappedColumns.map((entry) => (
          <li key={`${entry.teamId}:${entry.sourceColumn}`}>
            {entry.teamName || entry.teamId} — column “{entry.sourceColumn}”
            {' · '}
            {entry.cardCount} card{entry.cardCount === 1 ? '' : 's'}
          </li>
        ))}
      </ul>
    </section>
  );
}
