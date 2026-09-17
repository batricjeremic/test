/**
 * The BFF client, driven through an injected fetch so nothing here goes
 * near a real service.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ITERATION_ALIGNMENT,
  EMPTY_BOARD_FILTER_SET,
} from '@eg/shared';
import { createBoardApiClient } from './client';
import { CORRELATION_ID_HEADER } from './http';
import { isApiClientError } from './errors';
import { makeBoardCard, makeBoardSnapshot, FIXTURE_BOARD_ID } from './fixtures';
import { DEFAULT_BOARD_QUERY } from './query';

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWith(
  respond: (call: Call) => Response | Promise<Response>,
  calls: Call[] = [],
) {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return respond(call);
    },
  ) as unknown as typeof fetch;

  return {
    calls,
    client: createBoardApiClient({
      baseUrl: 'https://board.example/',
      getAccessToken: async () => 'token-abc',
      fetchImpl,
      newTraceId: () => 'trace-fixed',
    }),
  };
}

function headerOf(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

describe('BoardApiClient', () => {
  it('sends the token in the header, never in the URL', async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(makeBoardSnapshot()),
    );

    await client.getBoardSnapshot(FIXTURE_BOARD_ID, DEFAULT_BOARD_QUERY);

    const call = calls[0];
    expect(headerOf(call, 'authorization')).toBe('Bearer token-abc');
    expect(headerOf(call, CORRELATION_ID_HEADER)).toBe('trace-fixed');
    expect(call?.url).not.toContain('token');
  });

  it('encodes the iteration window and the filter set', async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(makeBoardSnapshot()),
    );

    await client.getBoardSnapshot(FIXTURE_BOARD_ID, {
      alignment: {
        mode: 'date-window',
        window: { start: '2026-09-01', end: '2026-09-30' },
      },
      grouping: 'team',
      filters: {
        ...EMPTY_BOARD_FILTER_SET,
        projectIds: ['Delivery'],
        tags: ['risk'],
      },
    });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe(`/api/boards/${FIXTURE_BOARD_ID}/sprint`);
    expect(url.searchParams.get('mode')).toBe('date-window');
    expect(url.searchParams.get('start')).toBe('2026-09-01');
    expect(url.searchParams.get('grouping')).toBe('team');
    expect(url.searchParams.get('projects')).toBe('Delivery');
    expect(url.searchParams.get('tags')).toBe('risk');
  });

  it('rejects a body that does not match the shared schema', async () => {
    const { client } = clientWith(() =>
      jsonResponse({ boardId: FIXTURE_BOARD_ID, cards: 'not an array' }),
    );

    await expect(
      client.getBoardSnapshot(FIXTURE_BOARD_ID, DEFAULT_BOARD_QUERY),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('turns a BFF error envelope into an ApiClientError', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        {
          code: 'board-not-found',
          message: 'No such board',
          status: 404,
          traceId: 'trace-server',
        },
        { status: 404 },
      ),
    );

    await expect(
      client.getBoardSnapshot('nope', DEFAULT_BOARD_QUERY),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      traceId: 'trace-server',
    });
  });

  it('times out rather than hanging forever', async () => {
    const { client } = clientWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const error = await client
      .getBoardSnapshot(FIXTURE_BOARD_ID, DEFAULT_BOARD_QUERY, {
        timeoutMs: 10,
      })
      .catch((caught: unknown) => caught);

    expect(isApiClientError(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'timeout' });
  });

  it('passes a move result straight through', async () => {
    const card = makeBoardCard({ canonicalColumnId: 'col-done', rev: 8 });
    const { client, calls } = clientWith(() =>
      jsonResponse({
        status: 'applied',
        workItemId: card.workItemId,
        card,
        stateChanged: true,
      }),
    );

    const result = await client.moveCard({
      boardId: FIXTURE_BOARD_ID,
      workItemId: card.workItemId,
      rev: 7,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-done',
    });

    expect(result.status).toBe('applied');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ rev: 7 });
  });

  it('maps a 403 onto permission-denied instead of throwing', async () => {
    const card = makeBoardCard();
    const { client } = clientWith(() =>
      jsonResponse({ message: 'nope' }, { status: 403 }),
    );

    const result = await client.moveCard(
      {
        boardId: FIXTURE_BOARD_ID,
        workItemId: card.workItemId,
        rev: card.rev,
        fromCanonicalColumnId: 'col-doing',
        toCanonicalColumnId: 'col-done',
      },
      { context: { card, projectName: 'Delivery' } },
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.failure.reason).toBe('permission-denied');
    }
  });

  it('maps a 409 onto revision-conflict', async () => {
    const card = makeBoardCard();
    const { client } = clientWith(() => new Response(null, { status: 409 }));

    const result = await client.moveCard(
      {
        boardId: FIXTURE_BOARD_ID,
        workItemId: card.workItemId,
        rev: card.rev,
        fromCanonicalColumnId: 'col-doing',
        toCanonicalColumnId: 'col-done',
      },
      { context: { card } },
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.failure.reason).toBe('revision-conflict');
    }
  });

  it('maps a 503 with Retry-After onto service-unavailable', async () => {
    const { client } = clientWith(
      () =>
        new Response(null, { status: 503, headers: { 'retry-after': '30' } }),
    );

    const result = await client.moveCard({
      boardId: FIXTURE_BOARD_ID,
      workItemId: 1001,
      rev: 7,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-done',
    });

    expect(result.status).toBe('failed');
    if (
      result.status === 'failed' &&
      result.failure.reason === 'service-unavailable'
    ) {
      expect(result.failure.retryAfterSeconds).toBe(30);
    } else {
      expect.unreachable('expected service-unavailable');
    }
  });

  it('honours a typed failure sent in the error envelope', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        {
          code: 'transition-not-allowed',
          message: 'New cannot go to Closed',
          status: 422,
          traceId: 'trace-server',
          details: {
            fromState: 'New',
            toState: 'Closed',
            allowedStates: ['Active'],
          },
        },
        { status: 422 },
      ),
    );

    const result = await client.moveCard({
      boardId: FIXTURE_BOARD_ID,
      workItemId: 1001,
      rev: 7,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-done',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.failure.reason).toBe('transition-not-allowed');
      if (result.failure.reason === 'transition-not-allowed') {
        expect(result.failure.allowedStates).toEqual(['Active']);
      }
    }
  });

  it('round-trips the admin mapping table', async () => {
    const mappings = [
      {
        boardId: FIXTURE_BOARD_ID,
        teamId: 'team-dev',
        sourceColumnId: 'Doing',
        canonicalColumnId: 'col-doing',
        targetState: 'Active',
      },
    ];
    const { client, calls } = clientWith(() => jsonResponse(mappings));

    const saved = await client.replaceColumnMappings(
      FIXTURE_BOARD_ID,
      mappings,
    );

    expect(saved).toEqual(mappings);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe(
      `/api/boards/${FIXTURE_BOARD_ID}/mappings`,
    );
  });

  it('uses the default alignment when the caller sends none', async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(makeBoardSnapshot()),
    );

    await client.getBoardSnapshot(FIXTURE_BOARD_ID, {
      alignment: DEFAULT_ITERATION_ALIGNMENT,
      grouping: null,
      filters: EMPTY_BOARD_FILTER_SET,
    });

    expect(new URL(calls[0]?.url ?? '').searchParams.get('mode')).toBe(
      'each-team-current',
    );
  });
});
