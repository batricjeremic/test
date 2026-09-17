/**
 * `useBoard` — one board load, kept fresh.
 *
 * Owns the store, fetches the snapshot for the given iteration window and
 * filters, subscribes to the board's realtime channel and applies the
 * deltas, and refetches when the realtime layer says we missed something
 * or has fallen back to polling.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type {
  BoardCard,
  BoardFilterSet,
  BoardGrouping,
  BoardPermissions,
  BoardSnapshot,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
  CardDelta,
  IterationAlignment,
  PersonLoad,
  UnmappedColumnRef,
} from '@eg/shared';
import { describeApiError, isApiClientError, useApiClient } from '../api';
import type { BoardApiClient, BoardQuery } from '../api';
import { encodeBoardQuery, resolveBffBaseUrl } from '../api';
import { resolveRealtimeUrl, useRealtime } from '../realtime';
import type {
  RealtimeConnectionState,
  RealtimeSocketFactory,
} from '../realtime';
import { useOptionalHubHost } from '../sdk';
import { createBoardStore } from './boardStore';
import type { BoardStatus, BoardStore, PendingMove } from './boardStore';

export type UseBoardOptions = {
  /** Null falls back to the board definition's `defaultGrouping`. */
  grouping?: BoardGrouping | null;
  /** Overrides the client from `ApiProvider`. Tests inject the fake. */
  client?: BoardApiClient;
  /** False holds the load, e.g. before a board has been chosen. */
  enabled?: boolean;
  /** False turns the realtime channel off entirely. */
  realtime?: boolean;
  /** Overrides the derived `wss://…/realtime` endpoint. */
  realtimeUrl?: string;
  /** Injected in tests so no real WebSocket is opened. */
  socketFactory?: RealtimeSocketFactory;
  /** Per-request timeout for the snapshot read. */
  timeoutMs?: number;
};

export type UseBoardResult = {
  boardId: string;
  status: BoardStatus;
  /** True while the first load or a refetch is in flight. */
  loading: boolean;
  /** The confirmed snapshot. Null until the first load lands. */
  data: BoardSnapshot | null;
  /** Cards with optimistic moves laid over them: what the board renders. */
  cards: readonly BoardCard[];
  cardsById: ReadonlyMap<number, BoardCard>;
  columns: readonly CanonicalColumn[];
  swimlanes: readonly BoardSwimlane[];
  teams: readonly BoardTeamView[];
  personLoad: readonly PersonLoad[];
  unmappedColumns: readonly UnmappedColumnRef[];
  permissions: BoardPermissions | null;
  /** Resolved grouping: the snapshot's, which honours the caller's ask. */
  grouping: BoardGrouping;
  error: Error | null;
  /** The error as a sentence safe to render. */
  errorMessage: string | null;
  /** Cards with a move in flight: locked, spinner showing. */
  pendingMoves: ReadonlyMap<number, PendingMove>;
  isCardLocked(workItemId: number): boolean;
  /** Live or degraded; the board must render "Live updates off". */
  realtime: RealtimeConnectionState;
  refetch(): Promise<void>;
  /** Applies a delta by hand. The realtime channel does this for you. */
  applyDelta(delta: CardDelta): void;
  /** The store `useMove` writes through. `BoardProvider` passes it on. */
  store: BoardStore;
};

export function useBoard(
  boardId: string,
  /** The iteration window: which sprint "this sprint" means. */
  alignment: IterationAlignment,
  filters: BoardFilterSet,
  options: UseBoardOptions = {},
): UseBoardResult {
  const {
    grouping: requestedGrouping = null,
    enabled = true,
    realtime = true,
    socketFactory,
    timeoutMs,
  } = options;

  const contextClient = useApiClient();
  const client = options.client ?? contextClient;
  const host = useOptionalHubHost();

  const store = useMemo(() => createBoardStore(), [boardId]);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );

  const query = useMemo<BoardQuery>(
    () => ({ alignment, grouping: requestedGrouping, filters }),
    [alignment, requestedGrouping, filters],
  );
  const queryKey = useMemo(() => encodeBoardQuery(query).toString(), [query]);
  const queryRef = useRef(query);
  queryRef.current = query;

  const runLoad = useCallback(
    async (next: BoardQuery, signal?: AbortSignal): Promise<void> => {
      store.loadStarted();
      try {
        const snapshot = await client.getBoardSnapshot(boardId, next, {
          ...(signal ? { signal } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        if (signal?.aborted === true) return;
        store.loadSucceeded(snapshot);
      } catch (error) {
        if (signal?.aborted === true) return;
        if (isApiClientError(error) && error.kind === 'aborted') return;
        store.loadFailed(asError(error));
      }
    },
    [store, client, boardId, timeoutMs],
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void runLoad(queryRef.current, controller.signal);
    return () => {
      controller.abort();
    };
  }, [enabled, runLoad, queryKey]);

  const refetch = useCallback(async (): Promise<void> => {
    await runLoad(queryRef.current);
  }, [runLoad]);

  const applyDelta = useCallback(
    (delta: CardDelta) => {
      store.applyDelta(delta);
    },
    [store],
  );

  const realtimeUrl = useMemo(
    () =>
      options.realtimeUrl ?? resolveRealtimeUrl(resolveBffBaseUrl(), boardId),
    [options.realtimeUrl, boardId],
  );

  const realtimeState = useRealtime({
    boardId,
    channel: state.snapshot?.realtime.channel ?? `board:${boardId}`,
    url: realtimeUrl,
    enabled: realtime && enabled && state.snapshot !== null,
    serverStatus: state.snapshot?.realtime ?? null,
    getAccessToken: () =>
      host ? host.getAccessToken() : Promise.reject(new Error('No host')),
    onDelta: (envelope) => {
      store.applyDelta(envelope.delta);
    },
    onRefetch: () => {
      void refetch();
    },
    ...(state.snapshot
      ? { pollIntervalSeconds: state.snapshot.realtime.pollIntervalSeconds }
      : {}),
    ...(socketFactory === undefined ? {} : { socketFactory }),
  });

  const snapshot = state.snapshot;

  return useMemo(
    () => ({
      boardId,
      status: state.status,
      loading: state.status === 'loading',
      data: snapshot,
      cards: state.cards,
      cardsById: state.cardsById,
      columns: snapshot?.columns ?? [],
      swimlanes: snapshot?.swimlanes ?? [],
      teams: snapshot?.teams ?? [],
      personLoad: snapshot?.personLoad ?? [],
      unmappedColumns: snapshot?.unmappedColumns ?? [],
      permissions: snapshot?.permissions ?? null,
      grouping: snapshot?.grouping ?? requestedGrouping ?? 'person',
      error: state.error,
      errorMessage: state.error ? describeApiError(state.error) : null,
      pendingMoves: state.pendingMoves,
      isCardLocked: (workItemId: number) => state.pendingMoves.has(workItemId),
      realtime: realtimeState,
      refetch,
      applyDelta,
      store,
    }),
    [
      boardId,
      state,
      snapshot,
      requestedGrouping,
      realtimeState,
      refetch,
      applyDelta,
      store,
    ],
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
