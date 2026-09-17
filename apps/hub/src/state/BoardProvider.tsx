/**
 * Puts one `useBoard` result in context so every view below — the board,
 * the capacity panel, the toolbar — reads the same store, and so
 * `useMove` can write through it.
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type {
  BoardFilterSet,
  BoardGrouping,
  IterationAlignment,
} from '@eg/shared';
import { useBoard } from './useBoard';
import type { UseBoardOptions, UseBoardResult } from './useBoard';

const BoardContext = createContext<UseBoardResult | null>(null);

export type BoardProviderProps = {
  boardId: string;
  /** The iteration window. */
  alignment: IterationAlignment;
  filters: BoardFilterSet;
  grouping?: BoardGrouping | null;
  /** Passed straight to `useBoard`; tests inject the client here. */
  options?: Omit<UseBoardOptions, 'grouping'>;
  children: ReactNode;
};

export function BoardProvider({
  boardId,
  alignment,
  filters,
  grouping = null,
  options,
  children,
}: BoardProviderProps): JSX.Element {
  const board = useBoard(boardId, alignment, filters, {
    ...options,
    grouping,
  });
  return (
    <BoardContext.Provider value={board}>{children}</BoardContext.Provider>
  );
}

/** The board. Throws outside `BoardProvider`, which is a bug. */
export function useBoardContext(): UseBoardResult {
  const board = useContext(BoardContext);
  if (!board) {
    throw new Error('useBoardContext must be used inside <BoardProvider>');
  }
  return board;
}
