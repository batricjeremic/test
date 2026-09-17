/**
 * `useRealtime` — one socket per mounted board, cleaned up on unmount.
 *
 * The hook owns the client's lifetime; callbacks are held in refs so a
 * re-render never tears down and reopens the socket.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { DEFAULT_POLL_INTERVAL_SECONDS } from '@eg/shared';
import type { RealtimeEnvelope, RealtimeStatus } from '@eg/shared';
import { createRealtimeClient } from './client';
import type { SequenceGap } from './client';
import type { RealtimeConnectionState, RealtimeSocketFactory } from './types';

export type UseRealtimeOptions = {
  boardId: string;
  /** Channel name from `snapshot.realtime.channel`. */
  channel: string;
  /** `wss://…` endpoint; see `resolveRealtimeUrl`. */
  url: string;
  /** False keeps the hook inert, e.g. before the first snapshot lands. */
  enabled?: boolean;
  /** `snapshot.realtime`: when it says `polling`, no socket is opened. */
  serverStatus?: RealtimeStatus | null;
  getAccessToken: () => Promise<string>;
  onDelta: (envelope: RealtimeEnvelope) => void;
  onRefetch: (cause: 'poll' | 'reconnect' | 'sequence-gap') => void;
  onGap?: (gap: SequenceGap) => void;
  pollIntervalSeconds?: number;
  socketFactory?: RealtimeSocketFactory;
};

export const OFFLINE_REALTIME_STATE: RealtimeConnectionState = {
  mode: 'offline',
  degraded: true,
  label: 'Live updates off',
  reason: null,
  attempts: 0,
  lastEventAt: null,
  nextRetryInMs: null,
  pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
};

export function useRealtime(
  options: UseRealtimeOptions,
): RealtimeConnectionState {
  const {
    boardId,
    channel,
    url,
    enabled = true,
    serverStatus = null,
    pollIntervalSeconds,
    socketFactory,
  } = options;

  const callbacks = useRef({
    getAccessToken: options.getAccessToken,
    onDelta: options.onDelta,
    onRefetch: options.onRefetch,
    onGap: options.onGap,
  });

  useEffect(() => {
    callbacks.current = {
      getAccessToken: options.getAccessToken,
      onDelta: options.onDelta,
      onRefetch: options.onRefetch,
      onGap: options.onGap,
    };
  });

  const client = useMemo(() => {
    if (!enabled) return null;
    return createRealtimeClient({
      url,
      boardId,
      channel,
      getAccessToken: () => callbacks.current.getAccessToken(),
      onDelta: (envelope) => callbacks.current.onDelta(envelope),
      onRefetch: (cause) => callbacks.current.onRefetch(cause),
      onGap: (gap) => callbacks.current.onGap?.(gap),
      ...(pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds }),
      ...(socketFactory === undefined ? {} : { socketFactory }),
    });
  }, [enabled, url, boardId, channel, pollIntervalSeconds, socketFactory]);

  useEffect(() => {
    if (!client) return;
    client.start();
    return () => {
      client.stop();
    };
  }, [client]);

  useEffect(() => {
    if (!client || !serverStatus) return;
    client.setServerStatus(serverStatus);
  }, [client, serverStatus]);

  const subscribe = useCallback(
    (listener: () => void) => client?.subscribe(listener) ?? (() => undefined),
    [client],
  );
  const getState = useCallback(
    () => client?.getState() ?? OFFLINE_REALTIME_STATE,
    [client],
  );

  return useSyncExternalStore(subscribe, getState, getState);
}
