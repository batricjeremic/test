/**
 * The board contribution's root.
 *
 * `main.tsx` mounts this inside the host, API and toast providers and
 * passes no props, so everything the board needs it resolves itself: the
 * board id, the filters from the URL, and then the snapshot.
 */
import { useFilters } from '../state';
import { BoardProvider } from '../state';
import { BoardScreen } from './BoardScreen';
import { useBoardId } from './useBoardId';
import './board.css';

export function BoardView(): JSX.Element {
  const filters = useFilters();
  const board = useBoardId();

  if (board.status === 'loading') {
    return (
      <div className="eg-hub eg-board-view">
        <section className="eg-panel eg-empty" role="status">
          <span className="eg-spinner" aria-hidden="true" /> Finding your board…
        </section>
      </div>
    );
  }

  if (board.status === 'error') {
    return (
      <div className="eg-hub eg-board-view">
        <section className="eg-panel" role="alert">
          <strong>The board list could not be loaded</strong>
          <p className="eg-lane__meta">{board.errorMessage}</p>
        </section>
      </div>
    );
  }

  if (board.boardId === null) {
    return (
      <div className="eg-hub eg-board-view">
        <section className="eg-panel eg-empty">
          <strong>No board has been set up yet</strong>
          <p>
            A board is a saved definition: the projects and teams it covers, its
            canonical columns, and how each team&apos;s columns map onto them.
            An administrator creates one on the board settings screen.
          </p>
        </section>
      </div>
    );
  }

  return (
    <BoardProvider
      boardId={board.boardId}
      alignment={filters.alignment}
      filters={filters.filters}
      grouping={filters.grouping}
    >
      <BoardScreen filters={filters} />
    </BoardProvider>
  );
}

export default BoardView;
