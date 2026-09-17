import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardDelta, RealtimeEnvelope } from '@eg/shared';
import { createRealtimeClient, resolveRealtimeUrl } from './client';
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from './types';

type FakeSocket = {
  url: string;
  handlers: RealtimeSocketHandlers;
  sent: string[];
  closed: boolean;
  send(data: string): void;
  close(): void;
};

function fakeSockets(): {
  sockets: FakeSocket[];
  factory: RealtimeSocketFactory;
} {
  const sockets: FakeSocket[] = [];
  const factory: RealtimeSocketFactory = (url, handlers) => {
    const socket: FakeSocket = {
      url,
      handlers,
      sent: [],
      closed: false,
      send(data) {
        this.sent.push(data);
      },
      close() {
        this.closed = true;
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

const movedDelta: CardDelta = {
  kind: 'card-moved',
  workItemId: 1001,
  rev: 8,
  fromCanonicalColumnId: 'col-doing',
  toCanonicalColumnId: 'col-done',
  sourceColumn: 'Done',
  state: 'Closed',
  assignedTo: null,
};

function envelope(sequence: number): RealtimeEnvelope {
  return {
    v: 1,
    boardId: 'board-delivery',
    channel: 'board:board-delivery',
    sequence,
    emittedAt: '2026-09-17T09:00:00.000Z',
    traceId: 'trace-rt',
    origin: 'service-hook',
    delta: movedDelta,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const { sockets, factory } = fakeSockets();
  const onDelta = vi.fn();
  const onRefetch = vi.fn();
  const onGap = vi.fn();
  const client = createRealtimeClient({
    url: 'wss://board.example/api/boards/board-delivery/realtime',
    boardId: 'board-delivery',
    channel: 'board:board-delivery',
    getAccessToken: async () => 'token-abc',
    onDelta,
    onRefetch,
    onGap,
    socketFactory: factory,
    random: () => 0.5,
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    attemptsBeforeDegraded: 2,
    pollIntervalSeconds: 30,
    ...overrides,
  });
  return { client, sockets, onDelta, onRefetch, onGap };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('realtime client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes with the token in the frame, never in the URL', async () => {
    const { client, sockets } = setup();
    client.start();
    const socket = sockets[0];
    expect(socket?.url).not.toContain('token');

    socket?.handlers.onOpen();
    await flush();

    expect(socket?.sent).toHaveLength(1);
    const frame = JSON.parse(socket?.sent[0] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({
      type: 'subscribe',
      boardId: 'board-delivery',
      channel: 'board:board-delivery',
      token: 'token-abc',
    });
    expect(client.getState().mode).toBe('live');
    expect(client.getState().degraded).toBe(false);
    expect(client.getState().label).toBe('Live');
    client.stop();
  });

  it('applies validated deltas and ignores anything else', async () => {
    const { client, sockets, onDelta } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(1)));
    sockets[0]?.handlers.onMessage('not json');
    sockets[0]?.handlers.onMessage(JSON.stringify({ hello: 'world' }));
    sockets[0]?.handlers.onMessage(
      JSON.stringify({ ...envelope(2), boardId: 'other-board' }),
    );

    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith(envelope(1));
    client.stop();
  });

  it('refetches when the sequence jumps', async () => {
    const { client, sockets, onRefetch, onGap } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(1)));
    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(4)));

    expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 4 });
    expect(onRefetch).toHaveBeenCalledWith('sequence-gap');
    client.stop();
  });

  it('ignores a replayed frame', async () => {
    const { client, sockets, onDelta } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(5)));
    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(5)));
    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(4)));

    expect(onDelta).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('reconnects with bounded exponential backoff', async () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    sockets[0]?.handlers.onClose();
    expect(client.getState().attempts).toBe(1);
    const firstDelay = client.getState().nextRetryInMs ?? 0;
    expect(firstDelay).toBe(1_000);

    await vi.advanceTimersByTimeAsync(firstDelay);
    expect(sockets).toHaveLength(2);

    sockets[1]?.handlers.onClose();
    expect(client.getState().attempts).toBe(2);
    expect(client.getState().nextRetryInMs).toBe(2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    sockets[2]?.handlers.onClose();
    // Capped, never unbounded.
    expect(client.getState().nextRetryInMs).toBeLessThanOrEqual(8_000);
    client.stop();
  });

  it('falls back to polling and says live updates are off', async () => {
    const { client, sockets, onRefetch } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    sockets[0]?.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]?.handlers.onClose();

    expect(client.getState().mode).toBe('polling');
    expect(client.getState().degraded).toBe(true);
    expect(client.getState().label).toBe('Live updates off');
    expect(client.getState().reason).toBe('client-fallback');

    onRefetch.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onRefetch).toHaveBeenCalledWith('poll');
    client.stop();
  });

  it('refetches once after a reconnect, because frames were missed', async () => {
    const { client, sockets, onRefetch } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();
    onRefetch.mockClear();

    sockets[0]?.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]?.handlers.onOpen();
    await flush();

    expect(client.getState().mode).toBe('live');
    expect(onRefetch).toHaveBeenCalledWith('reconnect');
    client.stop();
  });

  it('polls without a socket when the server says hooks are missing', async () => {
    const { client, sockets, onRefetch } = setup();
    client.setServerStatus({
      mode: 'polling',
      channel: 'board:board-delivery',
      pollIntervalSeconds: 30,
      reason: 'service-hooks-missing',
    });
    client.start();
    await flush();

    expect(sockets).toHaveLength(0);
    expect(client.getState().mode).toBe('polling');
    expect(client.getState().reason).toBe('service-hooks-missing');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onRefetch).toHaveBeenCalledWith('poll');
    client.stop();
  });

  it('leaks nothing on stop', async () => {
    const { client, sockets, onRefetch } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();
    sockets[0]?.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]?.handlers.onClose();

    client.stop();
    onRefetch.mockClear();

    const socketCount = sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(onRefetch).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(socketCount);
    expect(client.getState().mode).toBe('offline');
  });

  it('closes the socket it still holds when it stops', async () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.handlers.onOpen();
    await flush();

    client.stop();

    expect(sockets[0]?.closed).toBe(true);
    expect(client.getState().mode).toBe('offline');

    // A late frame from a socket we already let go must be ignored.
    sockets[0]?.handlers.onMessage(JSON.stringify(envelope(9)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('builds a ws URL from the BFF origin', () => {
    expect(resolveRealtimeUrl('https://board.example/', 'board-1')).toBe(
      'wss://board.example/api/boards/board-1/realtime',
    );
    expect(resolveRealtimeUrl('http://localhost:8080', 'board-1')).toBe(
      'ws://localhost:8080/api/boards/board-1/realtime',
    );
  });
});
