/**
 * The board: the working surface the whole product exists for.
 *
 * It renders canonical columns in their configured order, swimlanes by
 * person or by team with the unassigned lane pinned at the top, and
 * wires @dnd-kit — pointer and keyboard both — to the optimistic write
 * in `useMove`.
 *
 * Everything expensive is memoised on the snapshot. A drag changes one
 * context value, which repaints the drop targets and nothing else.
 *
 * Capacity appears twice on purpose and never twice at once: a person
 * lane carries that person's own bar, and the toolbar opens the full
 * panel, which is the only way to read load when the board is grouped by
 * team and there are no person lanes at all.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { ScreenReaderInstructions } from '@dnd-kit/core';
import type { PersonLoad } from '@eg/shared';
import { CapacityPanel, usePersonLoads } from '../capacity';
import { buildBoardMatrix, useBoardContext } from '../state';
import type { UseFiltersResult } from '../state';
import { useOptionalHubHost } from '../sdk';
import type { BoardViewState } from '../types';
import { initialBoardViewState } from '../types';
import { BoardGrid } from './BoardGrid';
import { BoardToasts } from './BoardToasts';
import { BoardToolbar } from './BoardToolbar';
import { FilterBar } from './FilterBar';
import { UnmappedColumnsNotice } from './UnmappedColumnsNotice';
import { WorkItemDrawer } from './WorkItemDrawer';
import { ActiveDragProvider } from './boardUi';
import type { BoardUi } from './boardUi';
import {
  buildColumnList,
  countCardsByColumn,
  orderSwimlanes,
  showsMixedCadence,
} from './layout';
import { useBoardDnd } from './useBoardDnd';
import './board.css';

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Press space or enter to pick this card up. Use the arrow keys to ' +
    'move it between columns in its lane, space or enter to drop it, ' +
    'escape to cancel. Columns this card cannot move to are announced ' +
    'as blocked.',
};

export type BoardScreenProps = {
  filters: UseFiltersResult;
};

export function BoardScreen({ filters }: BoardScreenProps): JSX.Element {
  const board = useBoardContext();
  const host = useOptionalHubHost();
  /** Visible people, heaviest first: whoever is over reads first. */
  const people = usePersonLoads();
  const [viewState, setViewState] = useState<BoardViewState>(() => ({
    ...initialBoardViewState,
  }));
  const [capacityOpen, setCapacityOpen] = useState(false);

  const columns = useMemo(
    () =>
      buildColumnList(
        board.boardId,
        board.columns,
        board.cards,
        board.unmappedColumns,
      ),
    [board.boardId, board.columns, board.cards, board.unmappedColumns],
  );

  const lanes = useMemo(
    () => orderSwimlanes(board.swimlanes, board.cards, board.grouping),
    [board.swimlanes, board.cards, board.grouping],
  );

  const matrix = useMemo(
    () => buildBoardMatrix(board.cards, lanes, columns, board.grouping),
    [board.cards, lanes, columns, board.grouping],
  );

  const cardCounts = useMemo(
    () => countCardsByColumn(board.cards, columns),
    [board.cards, columns],
  );

  /**
   * One entry per person the board may show, keyed for the lane headers.
   * `usePersonLoads` has already dropped anyone a `PersonOverride` hides,
   * so a lane can never end up showing somebody else's bar.
   */
  const personLoadByDescriptor = useMemo(() => {
    const byDescriptor = new Map<string, PersonLoad>();
    for (const person of people) byDescriptor.set(person.descriptor, person);
    return byDescriptor;
  }, [people]);

  const dnd = useBoardDnd({ columns, teams: board.teams });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const openWorkItem = useCallback((workItemId: number) => {
    setViewState((previous) => ({ ...previous, openWorkItemId: workItemId }));
  }, []);

  const closeWorkItem = useCallback(() => {
    setViewState((previous) => ({ ...previous, openWorkItemId: null }));
  }, []);

  const toggleCapacity = useCallback(() => {
    setCapacityOpen((open) => !open);
  }, []);

  /**
   * Collapse and expand every lane at once. A board with thirty people on
   * it is read one lane at a time, and collapsing thirty headers by hand
   * to find the two that matter is not a thing anyone does twice.
   */
  const setAllLanesCollapsed = useCallback(
    (collapsed: boolean) => {
      setViewState((previous) => ({
        ...previous,
        collapsedSwimlaneIds: collapsed ? lanes.map((lane) => lane.id) : [],
      }));
    },
    [lanes],
  );

  const toggleLane = useCallback((laneId: string) => {
    setViewState((previous) => ({
      ...previous,
      collapsedSwimlaneIds: previous.collapsedSwimlaneIds.includes(laneId)
        ? previous.collapsedSwimlaneIds.filter((id) => id !== laneId)
        : [...previous.collapsedSwimlaneIds, laneId],
    }));
  }, []);

  const ui = useMemo<BoardUi>(
    () => ({
      grouping: board.grouping,
      teams: board.teams,
      mixedCadence: showsMixedCadence(filters.alignment),
      personLoadByDescriptor,
      collapsedLaneIds: viewState.collapsedSwimlaneIds,
      isCardLocked: board.isCardLocked,
      openWorkItem,
      toggleLane,
      evaluate: dnd.evaluate,
    }),
    [
      board.grouping,
      board.teams,
      board.isCardLocked,
      personLoadByDescriptor,
      filters.alignment,
      viewState.collapsedSwimlaneIds,
      openWorkItem,
      toggleLane,
      dnd.evaluate,
    ],
  );

  const openCard =
    viewState.openWorkItemId === null
      ? null
      : (board.cardsById.get(viewState.openWorkItemId) ?? null);
  const openTeam =
    openCard === null
      ? undefined
      : board.teams.find((team) => team.teamId === openCard.teamId);
  const openProjectName =
    openCard === null
      ? ''
      : (board.teams.find((team) => team.teamId === openCard.teamId)?.iteration
          .projectName ?? openCard.project);

  return (
    <div className="eg-hub eg-board-view">
      <BoardToolbar
        boardName={board.data?.boardName ?? 'Sprint board'}
        grouping={board.grouping}
        filters={filters}
        realtime={board.realtime}
        hiddenCardCount={board.data?.hiddenCardCount ?? 0}
        loading={board.loading}
        capacityOpen={capacityOpen}
        onToggleCapacity={toggleCapacity}
        allCollapsed={
          lanes.length > 0 &&
          viewState.collapsedSwimlaneIds.length >= lanes.length
        }
        onToggleAllLanes={setAllLanesCollapsed}
        onRefresh={() => {
          void board.refetch();
        }}
      />

      <FilterBar filters={filters} teams={board.teams} cards={board.cards} />

      <UnmappedColumnsNotice unmappedColumns={board.unmappedColumns} />

      {capacityOpen ? <CapacityPanel people={people} /> : null}

      {board.error !== null ? (
        <section className="eg-panel" role="alert">
          <strong>The board could not be loaded</strong>
          <p className="eg-lane__meta">{board.errorMessage}</p>
          <button
            type="button"
            className="eg-button"
            data-variant="primary"
            onClick={() => {
              void board.refetch();
            }}
          >
            Try again
          </button>
        </section>
      ) : null}

      {board.data === null && board.error === null ? (
        <section className="eg-panel eg-empty" role="status">
          <span className="eg-spinner" aria-hidden="true" /> Loading the sprint
          board…
        </section>
      ) : null}

      {board.data !== null ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            announcements: dnd.announcements,
            screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
          }}
          onDragStart={dnd.onDragStart}
          onDragEnd={dnd.onDragEnd}
          onDragCancel={dnd.onDragCancel}
        >
          <ActiveDragProvider value={dnd.activeDrag}>
            {lanes.length === 0 ? (
              <section className="eg-panel eg-empty">
                Nothing is in this sprint window yet. Widen the filters, or
                check the board&apos;s teams on the settings screen.
              </section>
            ) : (
              <BoardGrid
                ui={ui}
                columns={columns}
                lanes={lanes}
                matrix={matrix}
                cardCounts={cardCounts}
                label={`${board.data.boardName}, grouped by ${board.grouping}`}
              />
            )}
          </ActiveDragProvider>

          <DragOverlay dropAnimation={null}>
            {dnd.activeDrag?.card ? (
              <article className="eg-card" data-state="dragging">
                <div className="eg-card__title">
                  {dnd.activeDrag.card.title}
                </div>
                <div className="eg-card__meta">
                  {dnd.activeDrag.card.type} {dnd.activeDrag.card.workItemId}
                </div>
              </article>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {openCard !== null ? (
        <WorkItemDrawer
          card={openCard}
          projectName={openProjectName}
          teamName={openTeam?.iteration.teamName ?? openCard.teamId}
          columnName={
            columns.find((column) => column.id === openCard.canonicalColumnId)
              ?.name ?? openCard.sourceColumn
          }
          url={
            host?.workItemUrl(openProjectName, openCard.workItemId) ??
            `#work-item-${openCard.workItemId}`
          }
          onOpenNative={async (workItemId) =>
            (await host?.openWorkItem(workItemId)) ?? false
          }
          onClose={closeWorkItem}
        />
      ) : null}

      <BoardToasts />
    </div>
  );
}
