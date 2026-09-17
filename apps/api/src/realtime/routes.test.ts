import { describe, expect, it } from 'vitest';
import type { Clock } from '../ports.js';
import { WebSocketHub } from './hub.js';
import { attachSocket } from './routes.js';
import { REALTIME_CLOSE_CODES } from './socket.js';
import { FakeSocket, RecordingLogger } from './test-support.js';

const clock: Clock = { now: () => new Date('2026-09-17T08:00:00.000Z') };

const makeHub = (maxSocketsPerIdentity = 5): WebSocketHub =>
  new WebSocketHub({
    logger: new RecordingLogger(),
    clock,
    maxSocketsPerIdentity,
  });

describe('attachSocket', () => {
  it('subscribes the socket and cleans up when the peer closes', () => {
    const hub = makeHub();
    const socket = new FakeSocket();

    const subscription = attachSocket({
      hub,
      socket,
      boardId: 'board-1',
      descriptor: 'aad.one',
      traceId: 'trace-1',
      logger: new RecordingLogger(),
    });

    expect(subscription).not.toBeNull();
    expect(hub.subscriberCount('board-1')).toBe(1);

    socket.emit('close');

    expect(hub.subscriberCount('board-1')).toBe(0);
    expect(hub.activeBoardIds()).toEqual([]);
    expect(subscription?.closed).toBe(true);
  });

  it('cleans up on a socket error too', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    attachSocket({
      hub,
      socket,
      boardId: 'board-1',
      descriptor: 'aad.one',
      traceId: 'trace-1',
      logger: new RecordingLogger(),
    });

    socket.emit('error');

    expect(hub.subscriberCount('board-1')).toBe(0);
  });

  it('treats a pong or any frame as proof of life', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    attachSocket({
      hub,
      socket,
      boardId: 'board-1',
      descriptor: 'aad.one',
      traceId: 'trace-1',
      logger: new RecordingLogger(),
    });

    hub.runHeartbeat();
    socket.emit('pong');
    expect(hub.runHeartbeat()).toBe(0);

    socket.emit('message');
    expect(hub.runHeartbeat()).toBe(0);
    expect(hub.subscriberCount('board-1')).toBe(1);
  });

  it('closes a socket the hub refuses instead of leaking it', () => {
    const hub = makeHub(1);
    attachSocket({
      hub,
      socket: new FakeSocket(),
      boardId: 'board-1',
      descriptor: 'aad.one',
      traceId: 'trace-1',
      logger: new RecordingLogger(),
    });
    const refused = new FakeSocket();

    const subscription = attachSocket({
      hub,
      socket: refused,
      boardId: 'board-2',
      descriptor: 'aad.one',
      traceId: 'trace-1',
      logger: new RecordingLogger(),
    });

    expect(subscription).toBeNull();
    expect(refused.closes[0]?.code).toBe(REALTIME_CLOSE_CODES.tryAgainLater);
    expect(hub.subscriberCount('board-2')).toBe(0);
  });
});
