/**
 * What every row, cell and card on the grid needs, bundled into one
 * object with a stable identity so a card never re-renders because a
 * sibling did.
 *
 * The card currently being dragged is deliberately NOT in here: it lives
 * in its own context, so picking a card up repaints the cells that can
 * accept it and nothing else.
 */
import { createContext, useContext } from 'react';
import type { BoardGrouping, BoardTeamView, PersonLoad } from '@eg/shared';
import type { CardDragData, ColumnDropData } from '../types';
import type { ActiveDrag, BoardDropDecision } from './useBoardDnd';

export type BoardUi = {
  grouping: BoardGrouping;
  teams: readonly BoardTeamView[];
  /** True when each team runs its own sprint: lane headers show dates. */
  mixedCadence: boolean;
  /**
   * Rolled-up load per person, keyed by descriptor, so a person lane can
   * draw the one bar the spec promises without reaching into the store.
   * People a `PersonOverride` hides are not in it.
   */
  personLoadByDescriptor: ReadonlyMap<string, PersonLoad>;
  /** Lane ids the user has collapsed. */
  collapsedLaneIds: readonly string[];
  isCardLocked(workItemId: number): boolean;
  openWorkItem(workItemId: number): void;
  toggleLane(laneId: string): void;
  evaluate(drag: CardDragData, drop: ColumnDropData): BoardDropDecision;
};

const ActiveDragContext = createContext<ActiveDrag | null>(null);

export const ActiveDragProvider = ActiveDragContext.Provider;

/** The card in the air, or null. Only drop targets need to know. */
export function useActiveDrag(): ActiveDrag | null {
  return useContext(ActiveDragContext);
}
