/**
 * Realtime transport types.
 *
 * The frames themselves are `RealtimeEnvelope` from `@eg/shared`; this
 * file holds only the client-side connection state and the socket
 * abstraction that lets a test drive the client without a server.
 */
import type { RealtimeStatus } from '@eg/shared';

export type RealtimeMode =
  /** Opening or reopening the socket. */
  | 'connecting'
  /** Socket held, deltas arriving. */
  | 'live'
  /** Socket could not be held: polling every 30 s, visibly degraded. */
  | 'polling'
  /** Stopped, e.g. the board unmounted. */
  | 'offline';

/**
 * What the board's status pill renders. Degraded mode must be visible
 * rather than silent, so `degraded` and `label` are part of the contract.
 */
export type RealtimeConnectionState = {
  mode: RealtimeMode;
  /** True whenever live updates are off. Drives the "live updates off" pill. */
  degraded: boolean;
  /** Ready-to-render label: "Live" or "Live updates off". */
  label: string;
  /** Why we are degraded, using the shared reason vocabulary. */
  reason: RealtimeStatus['reason'];
  /** Consecutive failed connection attempts; 0 while live. */
  attempts: number;
  /** Epoch ms of the last delta applied, or null. */
  lastEventAt: number | null;
  /** Milliseconds until the next reconnect attempt, when one is pending. */
  nextRetryInMs: number | null;
  /** Interval currently used while polling. */
  pollIntervalSeconds: number;
};

/** Callbacks a socket implementation drives. */
export type RealtimeSocketHandlers = {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
  onError(): void;
};

/** The subset of `WebSocket` the client uses. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
}

export type RealtimeSocketFactory = (
  url: string,
  handlers: RealtimeSocketHandlers,
) => RealtimeSocket;

/** The frame the hub sends after the socket opens. */
export type SubscribeFrame = {
  type: 'subscribe';
  v: number;
  boardId: string;
  channel: string;
  /** Short-lived user token. Sent in the frame, never in the URL. */
  token: string;
  /** Last sequence we applied, so the server can tell us about a gap. */
  lastSequence: number | null;
};
