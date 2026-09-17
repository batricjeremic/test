/**
 * The socket seam.
 *
 * Serves "Caching, rate limits and realtime": the hub pushes deltas to
 * every open board. Nothing below the hub needs a real `ws` socket, so
 * the hub is written against this interface and every test drives it
 * with a recording fake — no listening port, no timers left running.
 */

/** Close codes the hub uses, named so a log line reads. */
export const REALTIME_CLOSE_CODES = {
  /** Orderly shutdown of a healthy socket. */
  normal: 1000,
  /** The process is stopping, or the peer stopped answering pings. */
  goingAway: 1001,
  /** Unauthenticated, or not permitted to read that board. */
  policyViolation: 1008,
  /** Too many sockets already open for that identity. */
  tryAgainLater: 1013,
} as const;

export type RealtimeCloseCode =
  (typeof REALTIME_CLOSE_CODES)[keyof typeof REALTIME_CLOSE_CODES];

/** The part of a WebSocket the hub writes to. */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Liveness probe. A peer that never pongs back is reaped. */
  ping(): void;
  /** Hard drop, when a close frame would not be answered. */
  terminate?(): void;
}

/** The part of a WebSocket the connection handler listens on. */
export interface RealtimeSocketEvents {
  on(event: string, listener: (...args: never[]) => void): void;
}

/** A socket the hub can both write to and observe. */
export type ManagedSocket = RealtimeSocket & RealtimeSocketEvents;
