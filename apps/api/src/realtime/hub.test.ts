import { describe, expect, it } from 'vitest';
import { realtimeEnvelopeSchema, type CardDelta } from '@eg/shared';
import { isAppError } from '../errors.js';
import type { CallOptions, Clock } from '../ports.js';
import { WebSocketHub } from './hub.js';
import { REALTIME_CLOSE_CODES } from './socket.js';
import { FakeSocket, RecordingLogger, sampleCard } from './test-support.js';

const options: CallOptions = { traceId: 'trace-1' };
const clock: Clock = { now: () => new Date('2026-09-17T08:00:00.000Z') };

const delta: CardDelta = { kind: 'card-upserted', card: sampleCard() };

const makeHub = (
  overrides: { maxSocketsPerIdentity?: number; maxSocketsTotal?: number } = {},
): { hub: WebSocketHub; logger: RecordingLogger } => {
  const logger = new RecordingLogger();
  const hub = new WebSocketHub({ logger, clock, ...overrides });
  return { hub, logger };
};

describe('WebSocketHub subscriptions', () => {
  it('names a deterministic channel per board', () => {
    const { hub } = makeHub();
    expect(hub.channelFor('board-1')).toBe('board:board-1');
    expect(hub.channelFor('board-1')).toBe(hub.channelFor('board-1'));
  });

  it('counts subscribers per board and forgets them on close', () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    const subscription = hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket,
      traceId: 'trace-1',
    });

    expect(hub.subscriberCount('board-1')).toBe(1);
    expect(hub.activeBoardIds()).toEqual(['board-1']);

    subscription.close();

    expect(hub.subscriberCount('board-1')).toBe(0);
    // The channel map is emptied, not left holding an empty set.
    expect(hub.activeBoardIds()).toEqual([]);
    expect(hub.totalSubscriberCount).toBe(0);
    expect(socket.closes).toHaveLength(1);
  });

  it('closes idempotently', () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    const subscription = hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket,
      traceId: 'trace-1',
    });

    subscription.close();
    subscription.close();

    expect(socket.closes).toHaveLength(1);
    expect(subscription.closed).toBe(true);
  });

  it('bounds the sockets one identity may hold', () => {
    const { hub } = makeHub({ maxSocketsPerIdentity: 2 });
    for (let index = 0; index < 2; index += 1) {
      hub.subscribe({
        boardId: `board-${index}`,
        descriptor: 'aad.one',
        socket: new FakeSocket(),
        traceId: 'trace-1',
      });
    }

    let caught: unknown;
    try {
      hub.subscribe({
        boardId: 'board-3',
        descriptor: 'aad.one',
        socket: new FakeSocket(),
        traceId: 'trace-1',
      });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    expect(isAppError(caught) ? caught.status : 0).toBe(429);
    // Another identity is unaffected.
    expect(() =>
      hub.subscribe({
        boardId: 'board-3',
        descriptor: 'aad.two',
        socket: new FakeSocket(),
        traceId: 'trace-1',
      }),
    ).not.toThrow();
  });

  it('bounds the sockets the process holds in total', () => {
    const { hub } = makeHub({ maxSocketsTotal: 1 });
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket: new FakeSocket(),
      traceId: 'trace-1',
    });

    expect(() =>
      hub.subscribe({
        boardId: 'board-1',
        descriptor: 'aad.two',
        socket: new FakeSocket(),
        traceId: 'trace-1',
      }),
    ).toThrow();
  });
});

describe('WebSocketHub publishing', () => {
  it('delivers a delta to every socket on that board only', async () => {
    const { hub } = makeHub();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const other = new FakeSocket();
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket: first,
      traceId: 'trace-1',
    });
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.two',
      socket: second,
      traceId: 'trace-1',
    });
    hub.subscribe({
      boardId: 'board-2',
      descriptor: 'aad.three',
      socket: other,
      traceId: 'trace-1',
    });

    const envelope = await hub.publishDelta(
      { boardId: 'board-1', delta, origin: 'service-hook', traceId: 'trace-1' },
      options,
    );

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
    expect(realtimeEnvelopeSchema.parse(first.frames()[0])).toEqual(envelope);
    expect(envelope.channel).toBe('board:board-1');
    expect(envelope.origin).toBe('service-hook');
  });

  it('sequences per channel, so a gap is detectable', async () => {
    const { hub } = makeHub();
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket: new FakeSocket(),
      traceId: 'trace-1',
    });

    const first = await hub.publishDelta(
      { boardId: 'board-1', delta, origin: 'own-write', traceId: 'trace-1' },
      options,
    );
    const second = await hub.publishDelta(
      { boardId: 'board-1', delta, origin: 'own-write', traceId: 'trace-1' },
      options,
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it('is a no-op when nobody is listening', async () => {
    const { hub } = makeHub();
    await expect(
      hub.publishDelta(
        { boardId: 'board-1', delta, origin: 'sync-worker', traceId: 't' },
        options,
      ),
    ).resolves.toBeDefined();
  });

  it('drops a socket that fails to send and keeps serving the rest', async () => {
    const { hub } = makeHub();
    const broken = new FakeSocket();
    broken.sendFailure = new Error('EPIPE');
    const healthy = new FakeSocket();
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket: broken,
      traceId: 'trace-1',
    });
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.two',
      socket: healthy,
      traceId: 'trace-1',
    });

    await hub.publishDelta(
      { boardId: 'board-1', delta, origin: 'service-hook', traceId: 'trace-1' },
      options,
    );

    expect(healthy.sent).toHaveLength(1);
    expect(broken.closes).toHaveLength(1);
    expect(hub.subscriberCount('board-1')).toBe(1);
  });

  it('refuses to publish a malformed envelope', async () => {
    const { hub } = makeHub();
    await expect(
      hub.publish(
        {
          v: 1,
          boardId: '',
          channel: 'board:',
          sequence: -1,
          emittedAt: 'not-a-time',
          traceId: 'trace-1',
          origin: 'own-write',
          delta,
        },
        options,
      ),
    ).rejects.toThrow();
  });
});

describe('WebSocketHub heartbeat', () => {
  it('pings live sockets and reaps the ones that never pong', () => {
    const { hub } = makeHub();
    const answering = new FakeSocket();
    const dead = new FakeSocket();
    const alive = hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket: answering,
      traceId: 'trace-1',
    });
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.two',
      socket: dead,
      traceId: 'trace-1',
    });

    expect(hub.runHeartbeat()).toBe(0);
    expect(answering.pings).toBe(1);
    expect(dead.pings).toBe(1);

    alive.markAlive();
    expect(hub.runHeartbeat()).toBe(1);

    expect(hub.subscriberCount('board-1')).toBe(1);
    expect(dead.closes[0]?.code).toBe(REALTIME_CLOSE_CODES.goingAway);
    expect(answering.pings).toBe(2);
  });

  it('closes every socket and clears its maps on stop', () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.subscribe({
      boardId: 'board-1',
      descriptor: 'aad.one',
      socket,
      traceId: 'trace-1',
    });

    hub.start();
    hub.stop();

    expect(socket.closes).toHaveLength(1);
    expect(hub.totalSubscriberCount).toBe(0);
    expect(hub.activeBoardIds()).toEqual([]);
  });
});
