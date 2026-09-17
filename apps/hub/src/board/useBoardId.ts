/**
 * Which board are we looking at?
 *
 * The hub is mounted by a contribution, not by a router, so the board
 * comes from `?board=<id>` when there is one and from the board
 * definitions otherwise. A first-run organization with no board at all
 * is a state the view has to render, not a crash.
 */
import { useEffect, useState } from 'react';
import { describeApiError, useApiClient } from '../api';
import type { BoardApiClient } from '../api';

/** URL parameter that pins the hub to one board. Not a filter key. */
export const BOARD_ID_PARAM = 'board';

export type BoardIdState = {
  status: 'loading' | 'ready' | 'error';
  boardId: string | null;
  /** Known only when the id came from a board definition. */
  boardName: string | null;
  errorMessage: string | null;
};

export type UseBoardIdOptions = {
  client?: BoardApiClient;
  /** Overrides the URL, for tests and for the dev shell. */
  boardId?: string | null;
  search?: string;
};

export function useBoardId(options: UseBoardIdOptions = {}): BoardIdState {
  const contextClient = useApiClient();
  const client = options.client ?? contextClient;
  const explicit = options.boardId ?? readBoardIdFromUrl(options.search);

  const [state, setState] = useState<BoardIdState>(() =>
    explicit === null
      ? {
          status: 'loading',
          boardId: null,
          boardName: null,
          errorMessage: null,
        }
      : {
          status: 'ready',
          boardId: explicit,
          boardName: null,
          errorMessage: null,
        },
  );

  useEffect(() => {
    if (explicit !== null) {
      setState({
        status: 'ready',
        boardId: explicit,
        boardName: null,
        errorMessage: null,
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const definitions = await client.listBoardDefinitions({
          signal: controller.signal,
        });
        if (cancelled) return;
        const first = definitions[0];
        setState({
          status: 'ready',
          boardId: first?.id ?? null,
          boardName: first?.name ?? null,
          errorMessage: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: 'error',
          boardId: null,
          boardName: null,
          errorMessage: describeApiError(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, explicit]);

  return state;
}

function readBoardIdFromUrl(search?: string): string | null {
  const source =
    search ?? (typeof window === 'undefined' ? '' : window.location.search);
  const value = new URLSearchParams(source).get(BOARD_ID_PARAM);
  return value === null || value === '' ? null : value;
}
