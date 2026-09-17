/**
 * The board's realtime client.
 *
 * Holds one WebSocket per open board, applies deltas, reconnects with
 * bounded exponential backoff, and falls back to polling every 30 seconds
 * when the socket cannot be held. Degraded mode is exposed as state, not
 * swallowed: the board renders "Live updates off" from it.
 *
 * Nothing here logs, and the access token is sent in the subscribe frame
 * rather than in the URL, because URLs end up in proxy logs.
 */
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  REALTIME_PROTOCOL_VERSION,
  realtimeEnvelopeSchema,
} from '@eg/shared';
import type { RealtimeEnvelope, RealtimeStatus } from '@eg/shared';
import type {
  RealtimeConnectionState,
  RealtimeSocket,
  RealtimeSocketFactory,
  SubscribeFrame,
} from './types';

export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Failed attempts tolerated before the board says live updates are off. */
export const DEFAULT_ATTEMPTS_BEFORE_DEGRADED = 2;

export type SequenceGap = { expected: number; received: number };

export type RealtimeClientOptions = {
  /** `wss://…/api/boards/{boardId}/realtime`. Carries no token. */
  url: string;
  boardId: string;
  channel: string;
  /** Short-lived user token, fetched fresh for every subscribe frame. */
  getAccessToken: () => Promise<string>;
  /** One validated delta. */
  onDelta: (envelope: RealtimeEnvelope) => void;
  /**
   * Refetch the snapshot: called on every poll tick while degraded, once
   * after a reconnect, and whenever a sequence gap says we missed frames.
   */
  onRefetch: (cause: 'poll' | 'reconnect' | 'sequence-gap') => void;
  /** Sequence gap detail, for a board that wants to say why it refetched. */
  onGap?: (gap: SequenceGap) => void;
  pollIntervalSeconds?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  attemptsBeforeDegraded?: number;
  /** Injected in tests. Defaults to a real `WebSocket`. */
  socketFactory?: RealtimeSocketFactory;
  /** Injected in tests to make backoff deterministic. */
  random?: () => number;
};

export interface RealtimeClient {
  start(): void;
  /** Closes the socket and clears every timer. Safe to call twice. */
  stop(): void;
  getState(): RealtimeConnectionState;
  subscribe(listener: (state: RealtimeConnectionState) => void): () => void;
  /**
   * Applies the server's own view of realtime from the snapshot. When it
   * says `polling`, the socket is not even attempted.
   */
  setServerStatus(status: RealtimeStatus): void;
}

export function createRealtimeClient(
  options: RealtimeClientOptions,
): RealtimeClient {
  const pollIntervalSeconds =
    options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const initialBackoffMs =
    options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const attemptsBeforeDegraded =
    options.attemptsBeforeDegraded ?? DEFAULT_ATTEMPTS_BEFORE_DEGRADED;
  const random = options.random ?? Math.random;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;

  const listeners = new Set<(state: RealtimeConnectionState) => void>();
  let state: RealtimeConnectionState = {
    mode: 'offline',
    degraded: false,
    label: LIVE_LABEL,
    reason: null,
    attempts: 0,
    lastEventAt: null,
    nextRetryInMs: null,
    pollIntervalSeconds,
  };

  let socket: RealtimeSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSequence: number | null = null;
  let running = false;
  let socketsDisabled = false;
  let serverReason: RealtimeStatus['reason'] = null;
  let hadLiveConnection = false;
  /** Guards against a late callback from a socket we already replaced. */
  let generation = 0;

  const emit = (patch: Partial<RealtimeConnectionState>): void => {
    const next: RealtimeConnectionState = { ...state, ...patch };
    next.degraded = next.mode !== 'live';
    next.label =
      next.mode === 'live'
        ? LIVE_LABEL
        : next.mode === 'connecting'
          ? CONNECTING_LABEL
          : DEGRADED_LABEL;
    state = next;
    for (const listener of listeners) listener(state);
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const startPolling = (reason: RealtimeStatus['reason']): void => {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      options.onRefetch('poll');
    }, pollIntervalSeconds * 1000);
    emit({ mode: 'polling', reason });
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const closeSocket = (): void => {
    if (socket) {
      generation += 1;
      try {
        socket.close();
      } catch {
        /* a socket that refuses to close is already gone */
      }
      socket = null;
    }
  };

  const handleEnvelope = (raw: string): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = realtimeEnvelopeSchema.safeParse(payload);
    if (!parsed.success) return;
    const envelope = parsed.data;
    if (envelope.boardId !== options.boardId) return;

    if (lastSequence !== null) {
      if (envelope.sequence <= lastSequence) return;
      if (envelope.sequence > lastSequence + 1) {
        const gap = { expected: lastSequence + 1, received: envelope.sequence };
        options.onGap?.(gap);
        options.onRefetch('sequence-gap');
      }
    }
    lastSequence = envelope.sequence;
    emit({ lastEventAt: Date.now() });
    options.onDelta(envelope);
  };

  const scheduleReconnect = (): void => {
    if (!running || socketsDisabled) return;
    const attempts = state.attempts + 1;
    const degraded = attempts >= attemptsBeforeDegraded;
    const delay = backoffDelay(
      attempts,
      initialBackoffMs,
      maxBackoffMs,
      random,
    );

    if (degraded) startPolling(serverReason ?? 'client-fallback');
    emit({
      attempts,
      nextRetryInMs: delay,
      mode: degraded ? 'polling' : 'connecting',
      reason: degraded ? (serverReason ?? 'client-fallback') : state.reason,
    });

    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  const openSocket = (): void => {
    if (!running || socketsDisabled) return;
    closeSocket();
    const thisGeneration = generation;
    emit({ mode: state.degraded ? state.mode : 'connecting' });

    let created: RealtimeSocket;
    try {
      created = socketFactory(options.url, {
        onOpen: () => {
          if (thisGeneration !== generation) return;
          void sendSubscribe(thisGeneration);
        },
        onMessage: (data) => {
          if (thisGeneration !== generation) return;
          handleEnvelope(data);
        },
        onClose: () => {
          if (thisGeneration !== generation) return;
          socket = null;
          scheduleReconnect();
        },
        onError: () => {
          if (thisGeneration !== generation) return;
        },
      });
    } catch {
      scheduleReconnect();
      return;
    }
    socket = created;
  };

  const sendSubscribe = async (thisGeneration: number): Promise<void> => {
    let token: string;
    try {
      token = await options.getAccessToken();
    } catch {
      if (thisGeneration === generation) scheduleReconnect();
      return;
    }
    if (thisGeneration !== generation || !socket) return;

    const frame: SubscribeFrame = {
      type: 'subscribe',
      v: REALTIME_PROTOCOL_VERSION,
      boardId: options.boardId,
      channel: options.channel,
      token,
      lastSequence,
    };
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      scheduleReconnect();
      return;
    }

    stopPolling();
    const reconnected = hadLiveConnection;
    hadLiveConnection = true;
    emit({ mode: 'live', attempts: 0, nextRetryInMs: null, reason: null });
    if (reconnected) options.onRefetch('reconnect');
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      if (!socketFactoryAvailable(options.socketFactory)) {
        socketsDisabled = true;
      }
      if (socketsDisabled) {
        startPolling(serverReason ?? 'client-fallback');
        return;
      }
      openSocket();
    },

    stop: () => {
      running = false;
      clearReconnect();
      stopPolling();
      closeSocket();
      emit({ mode: 'offline', nextRetryInMs: null });
    },

    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setServerStatus: (status) => {
      serverReason = status.reason;
      if (status.mode === 'polling') {
        socketsDisabled = true;
        clearReconnect();
        closeSocket();
        if (running) startPolling(status.reason ?? 'service-hooks-missing');
        return;
      }
      if (socketsDisabled) {
        socketsDisabled = false;
        if (running) openSocket();
      }
    },
  };
}

const LIVE_LABEL = 'Live';
const CONNECTING_LABEL = 'Connecting…';
const DEGRADED_LABEL = 'Live updates off';

/** Exponential backoff with +/-20% jitter, capped. */
export function backoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const raw = initialMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, raw);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(capped * jitter);
}

/** `http(s)://host` plus a board id becomes `ws(s)://host/…/realtime`. */
export function resolveRealtimeUrl(baseUrl: string, boardId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const wsBase = base.replace(/^http/i, (match) =>
    match === 'HTTP' ? 'WS' : 'ws',
  );
  return `${wsBase}/api/boards/${encodeURIComponent(boardId)}/realtime`;
}

function socketFactoryAvailable(
  injected: RealtimeSocketFactory | undefined,
): boolean {
  return injected !== undefined || typeof globalThis.WebSocket === 'function';
}

const defaultSocketFactory: RealtimeSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => handlers.onOpen());
  ws.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  ws.addEventListener('close', () => handlers.onClose());
  ws.addEventListener('error', () => handlers.onError());
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
  };
};
