/**
 * The realtime hub: one channel per board.
 *
 * Serves "Caching, rate limits and realtime" — a card delta is pushed to
 * every board open on that channel, so two people dragging cards see
 * each other. This is the `RealtimePublisher` port.
 *
 * Three properties matter more than throughput:
 *
 * - **Nothing leaks.** Every subscription is held in exactly two maps and
 *   both are pruned on close. An empty channel is deleted, not left
 *   behind as an empty set; a leaked channel map is how this service
 *   dies at 3am.
 * - **Dead sockets are reaped.** A peer that misses a heartbeat round is
 *   closed, because a socket that is never written to looks identical to
 *   a healthy one until the process runs out of handles.
 * - **One identity cannot exhaust the process.** Sockets are bounded per
 *   identity and in total, and the refusal is an `AppError` the route can
 *   turn into a close frame.
 *
 * Only descriptors and board ids are logged, never display names.
 */
import { randomUUID } from 'node:crypto';
import { realtimeEnvelopeSchema, REALTIME_PROTOCOL_VERSION } from '@eg/shared';
import type {
  CardDelta,
  DeltaOrigin,
  Descriptor,
  RealtimeEnvelope,
} from '@eg/shared';
import { RateLimitedError } from '../errors.js';
import type {
  CallOptions,
  Clock,
  Logger,
  RealtimePublisher,
} from '../ports.js';
import { REALTIME_CLOSE_CODES, type RealtimeSocket } from './socket.js';

/** Channel names are `board:<id>`, so the hub can be asked for one. */
export const REALTIME_CHANNEL_PREFIX = 'board';

/** Sockets one identity may hold open across all boards. */
export const DEFAULT_MAX_SOCKETS_PER_IDENTITY = 5;

/** Sockets the process will hold open at all. */
export const DEFAULT_MAX_SOCKETS_TOTAL = 500;

/** Heartbeat period. A peer that misses one round is closed. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** A live client subscription, as the route handler sees it. */
export interface BoardSubscription {
  readonly id: string;
  readonly boardId: string;
  readonly channel: string;
  readonly descriptor: Descriptor;
  readonly closed: boolean;
  /** Called when the peer pongs; a round without one reaps the socket. */
  markAlive(): void;
  /** Idempotent. Removes the subscription and closes the socket once. */
  close(code?: number, reason?: string): void;
}

export interface SubscribeInput {
  readonly boardId: string;
  readonly descriptor: Descriptor;
  readonly socket: RealtimeSocket;
  readonly traceId: string;
}

export interface WebSocketHubOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly maxSocketsPerIdentity?: number;
  readonly maxSocketsTotal?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface PublishDeltaInput {
  readonly boardId: string;
  readonly delta: CardDelta;
  readonly origin: DeltaOrigin;
  readonly traceId: string;
}

class Subscription implements BoardSubscription {
  readonly id = randomUUID();
  readonly boardId: string;
  readonly channel: string;
  readonly descriptor: Descriptor;
  readonly socket: RealtimeSocket;
  alive = true;
  closed = false;
  readonly onClose: (subscription: Subscription) => void;

  constructor(
    input: SubscribeInput,
    channel: string,
    onClose: (subscription: Subscription) => void,
  ) {
    this.boardId = input.boardId;
    this.channel = channel;
    this.descriptor = input.descriptor;
    this.socket = input.socket;
    this.onClose = onClose;
  }

  markAlive(): void {
    this.alive = true;
  }

  close(code: number = REALTIME_CLOSE_CODES.normal, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate?.();
    }
  }
}

export class WebSocketHub implements RealtimePublisher {
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #maxPerIdentity: number;
  readonly #maxTotal: number;
  readonly #heartbeatIntervalMs: number;
  readonly #byBoard = new Map<string, Set<Subscription>>();
  readonly #byIdentity = new Map<Descriptor, Set<Subscription>>();
  readonly #sequences = new Map<string, number>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketHubOptions) {
    this.#logger = options.logger.child({ component: 'realtime-hub' });
    this.#clock = options.clock;
    this.#maxPerIdentity =
      options.maxSocketsPerIdentity ?? DEFAULT_MAX_SOCKETS_PER_IDENTITY;
    this.#maxTotal = options.maxSocketsTotal ?? DEFAULT_MAX_SOCKETS_TOTAL;
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /* ---------------------------------------------------------------- */
  /* RealtimePublisher                                                 */
  /* ---------------------------------------------------------------- */

  channelFor(boardId: string): string {
    return `${REALTIME_CHANNEL_PREFIX}:${boardId}`;
  }

  subscriberCount(boardId: string): number {
    return this.#byBoard.get(boardId)?.size ?? 0;
  }

  /**
   * Fans one envelope out to a board's sockets. A socket that throws is
   * closed rather than retried: the delta is a hint, and the client
   * refetches the snapshot when it reconnects.
   */
  async publish(
    envelope: RealtimeEnvelope,
    options: CallOptions,
  ): Promise<void> {
    const parsed = realtimeEnvelopeSchema.parse(envelope);
    const subscriptions = this.#byBoard.get(parsed.boardId);
    const log = this.#logger.withTraceId(options.traceId);
    if (subscriptions === undefined || subscriptions.size === 0) {
      log.debug('no subscribers for board', {
        boardId: parsed.boardId,
        kind: parsed.delta.kind,
      });
      return;
    }

    const frame = JSON.stringify(parsed);
    let delivered = 0;
    let dropped = 0;
    for (const subscription of [...subscriptions]) {
      if (subscription.closed) continue;
      try {
        subscription.socket.send(frame);
        delivered += 1;
      } catch (error) {
        dropped += 1;
        log.warn('realtime send failed, closing socket', {
          boardId: parsed.boardId,
          descriptor: subscription.descriptor,
          error: error instanceof Error ? error.message : 'unknown',
        });
        subscription.close(REALTIME_CLOSE_CODES.goingAway, 'send failed');
      }
    }
    log.debug('realtime delta published', {
      boardId: parsed.boardId,
      kind: parsed.delta.kind,
      origin: parsed.origin,
      sequence: parsed.sequence,
      delivered,
      dropped,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Envelopes                                                         */
  /* ---------------------------------------------------------------- */

  /** Next sequence for a channel. A gap tells the hub to refetch. */
  nextSequence(boardId: string): number {
    const next = (this.#sequences.get(boardId) ?? 0) + 1;
    this.#sequences.set(boardId, next);
    return next;
  }

  /** Builds a validated envelope carrying the next channel sequence. */
  buildEnvelope(input: PublishDeltaInput): RealtimeEnvelope {
    return realtimeEnvelopeSchema.parse({
      v: REALTIME_PROTOCOL_VERSION,
      boardId: input.boardId,
      channel: this.channelFor(input.boardId),
      sequence: this.nextSequence(input.boardId),
      emittedAt: this.#clock.now().toISOString(),
      traceId: input.traceId,
      origin: input.origin,
      delta: input.delta,
    });
  }

  /** Sequences, builds and publishes in one step. */
  async publishDelta(
    input: PublishDeltaInput,
    options: CallOptions,
  ): Promise<RealtimeEnvelope> {
    const envelope = this.buildEnvelope(input);
    await this.publish(envelope, options);
    return envelope;
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Registers a socket on a board channel. Throws `RateLimitedError`
   * when the identity or the process is already at its socket budget;
   * the route turns that into a close frame rather than a leak.
   */
  subscribe(input: SubscribeInput): BoardSubscription {
    const held = this.#byIdentity.get(input.descriptor);
    if ((held?.size ?? 0) >= this.#maxPerIdentity) {
      throw new RateLimitedError(
        'Too many board connections are open for this identity.',
        null,
        { details: { boardId: input.boardId, limit: this.#maxPerIdentity } },
      );
    }
    if (this.totalSubscriberCount >= this.#maxTotal) {
      throw new RateLimitedError(
        'The realtime hub is at capacity, please retry shortly.',
        null,
        { details: { limit: this.#maxTotal } },
      );
    }

    const subscription = new Subscription(
      input,
      this.channelFor(input.boardId),
      (closing) => this.#forget(closing),
    );
    const board = this.#byBoard.get(input.boardId) ?? new Set<Subscription>();
    board.add(subscription);
    this.#byBoard.set(input.boardId, board);
    const identity = held ?? new Set<Subscription>();
    identity.add(subscription);
    this.#byIdentity.set(input.descriptor, identity);

    this.#logger.withTraceId(input.traceId).info('board subscribed', {
      boardId: input.boardId,
      descriptor: input.descriptor,
      channel: subscription.channel,
      subscribers: board.size,
    });
    return subscription;
  }

  get totalSubscriberCount(): number {
    let total = 0;
    for (const board of this.#byBoard.values()) total += board.size;
    return total;
  }

  /** Board ids with at least one open socket. */
  activeBoardIds(): readonly string[] {
    return [...this.#byBoard.keys()];
  }

  /**
   * One heartbeat round: reap the peers that did not pong since the last
   * round, ping the rest. Returns how many were reaped, which the tests
   * assert on and the caller may log.
   */
  runHeartbeat(): number {
    let reaped = 0;
    for (const board of [...this.#byBoard.values()]) {
      for (const subscription of [...board]) {
        if (subscription.closed) continue;
        if (!subscription.alive) {
          reaped += 1;
          this.#logger.info('reaping unresponsive socket', {
            boardId: subscription.boardId,
            descriptor: subscription.descriptor,
          });
          subscription.close(
            REALTIME_CLOSE_CODES.goingAway,
            'heartbeat timeout',
          );
          continue;
        }
        subscription.alive = false;
        try {
          subscription.socket.ping();
        } catch {
          subscription.close(REALTIME_CLOSE_CODES.goingAway, 'ping failed');
        }
      }
    }
    return reaped;
  }

  /** Starts the heartbeat. Idempotent; the timer never holds the loop. */
  start(): void {
    if (this.#heartbeat !== null) return;
    const timer = setInterval(() => {
      this.runHeartbeat();
    }, this.#heartbeatIntervalMs);
    timer.unref?.();
    this.#heartbeat = timer;
  }

  /** Stops the heartbeat and closes every socket. Idempotent. */
  stop(reason = 'server shutting down'): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    for (const board of [...this.#byBoard.values()]) {
      for (const subscription of [...board]) {
        subscription.close(REALTIME_CLOSE_CODES.goingAway, reason);
      }
    }
    this.#byBoard.clear();
    this.#byIdentity.clear();
    this.#sequences.clear();
  }

  #forget(subscription: Subscription): void {
    const board = this.#byBoard.get(subscription.boardId);
    if (board !== undefined) {
      board.delete(subscription);
      if (board.size === 0) {
        this.#byBoard.delete(subscription.boardId);
        this.#sequences.delete(subscription.boardId);
      }
    }
    const identity = this.#byIdentity.get(subscription.descriptor);
    if (identity !== undefined) {
      identity.delete(subscription);
      if (identity.size === 0) {
        this.#byIdentity.delete(subscription.descriptor);
      }
    }
    this.#logger.debug('board unsubscribed', {
      boardId: subscription.boardId,
      descriptor: subscription.descriptor,
      subscribers: this.subscriberCount(subscription.boardId),
    });
  }
}
