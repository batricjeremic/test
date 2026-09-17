import { beforeEach, describe, expect, it } from 'vitest';
import type { AdoConfig } from '../config.js';
import {
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
  UpstreamError,
  UpstreamTimeoutError,
  isAppError,
} from '../errors.js';
import type {
  AdoAuth,
  AdoCallOptions,
  Clock,
  LogFields,
  Logger,
} from '../ports.js';
import { createAdoClient, type UndiciAdoClient } from './client.js';
import { buildColumnMovePatch } from './patch.js';
import { TokenBucket } from './rate-limit.js';
import type { AdoHttpRequest, AdoHttpResponse } from './transport.js';

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

class FakeLogger implements Logger {
  readonly traceId: string;
  readonly lines: { level: string; message: string; fields: LogFields }[] = [];

  constructor(traceId = 'trace-root') {
    this.traceId = traceId;
  }
  child(_bindings: LogFields): Logger {
    return this;
  }
  withTraceId(_traceId: string): Logger {
    return this;
  }
  debug(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'debug', message, fields });
  }
  info(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'error', message, fields });
  }
}

class FakeClock implements Clock {
  #ms = Date.parse('2026-09-17T09:00:00.000Z');
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

type Responder = (request: AdoHttpRequest) => AdoHttpResponse;

class FakeTransport {
  readonly requests: AdoHttpRequest[] = [];
  readonly #responders: Responder[] = [];
  #fallback: Responder = () => json(200, {});

  queue(...responders: Responder[]): this {
    this.#responders.push(...responders);
    return this;
  }
  always(responder: Responder): this {
    this.#fallback = responder;
    return this;
  }
  readonly send = async (request: AdoHttpRequest): Promise<AdoHttpResponse> => {
    this.requests.push(request);
    const responder = this.#responders.shift() ?? this.#fallback;
    return responder(request);
  };
}

const json = (
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): AdoHttpResponse => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const CONFIG: AdoConfig = {
  orgUrl: 'https://dev.azure.com/expertgroup',
  serviceToken: 'service-pat-value',
  requestTimeoutMs: 10_000,
};

const SERVICE_AUTH: AdoAuth = { kind: 'service' };
const USER_AUTH: AdoAuth = {
  kind: 'user',
  accessToken: 'user-access-token',
  descriptor: 'aad.user-1',
};

const readOptions: AdoCallOptions = {
  traceId: 'trace-1',
  auth: SERVICE_AUTH,
};
const writeOptions: AdoCallOptions = {
  traceId: 'trace-2',
  auth: USER_AUTH,
};

interface Harness {
  readonly client: UndiciAdoClient;
  readonly transport: FakeTransport;
  readonly logger: FakeLogger;
  readonly clock: FakeClock;
  readonly slept: number[];
}

const harness = (transport: FakeTransport): Harness => {
  const logger = new FakeLogger();
  const clock = new FakeClock();
  const slept: number[] = [];
  const client = createAdoClient({
    config: CONFIG,
    logger,
    clock,
    transport: transport.send,
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
    random: () => 0,
    tokenBucket: new TokenBucket({
      capacity: 50,
      refillPerMinute: 6_000,
      clock,
    }),
  });
  return { client, transport, logger, clock, slept };
};

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
});

/* ------------------------------------------------------------------ */
/* Request shape                                                       */
/* ------------------------------------------------------------------ */

describe('request construction', () => {
  it('sets an explicit headers and body timeout on every call', async () => {
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listProjects(readOptions);
    const sent = transport.requests[0];
    expect(sent?.headersTimeoutMs).toBe(10_000);
    expect(sent?.bodyTimeoutMs).toBe(10_000);
    expect(sent?.signal.aborted).toBe(false);
  });

  it('lets one call override the configured timeout', async () => {
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listProjects({ ...readOptions, timeoutMs: 1_500 });
    expect(transport.requests[0]?.headersTimeoutMs).toBe(1_500);
    expect(transport.requests[0]?.bodyTimeoutMs).toBe(1_500);
  });

  it('runs reads as the service identity with basic auth', async () => {
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listProjects(readOptions);
    const expected = Buffer.from(':service-pat-value', 'utf8').toString(
      'base64',
    );
    expect(transport.requests[0]?.headers['authorization']).toBe(
      `Basic ${expected}`,
    );
  });

  it('runs writes as the calling user with a bearer token', async () => {
    transport.always(() => json(200, { id: 1, rev: 2, fields: {} }));
    const { client } = harness(transport);
    await client.updateWorkItem(1, [], writeOptions);
    expect(transport.requests[0]?.headers['authorization']).toBe(
      'Bearer user-access-token',
    );
  });

  it('builds the spec endpoint paths with an api-version', async () => {
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listTeamIterations('proj 1', 'team-a', 'current', readOptions);
    const url = transport.requests[0]?.url ?? '';
    expect(url).toContain(
      '/proj%201/team-a/_apis/work/teamsettings/iterations?',
    );
    expect(url).toContain('api-version=');
    expect(url).toContain('$timeframe=current');
  });

  it('omits the timeframe when every iteration is wanted', async () => {
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listTeamIterations('proj-1', 'team-a', null, readOptions);
    expect(transport.requests[0]?.url).not.toContain('$timeframe');
  });

  it('queries the whole organization when wiql has no project', async () => {
    transport.always(() => json(200, {}));
    const { client } = harness(transport);
    await client.queryWiql({ query: 'SELECT [System.Id]' }, null, readOptions);
    expect(transport.requests[0]?.url).toContain(
      'https://dev.azure.com/expertgroup/_apis/wit/wiql?',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Rate limit headers                                                  */
/* ------------------------------------------------------------------ */

describe('rate limit headers', () => {
  it('records the budget on a successful response, not only on 429', async () => {
    transport.always(() =>
      json(
        200,
        { count: 0, value: [] },
        {
          'x-ratelimit-remaining': '42',
          'x-ratelimit-limit': '200',
          'x-ratelimit-reset': '1789000000',
        },
      ),
    );
    const { client } = harness(transport);
    expect(client.rateLimitState(SERVICE_AUTH)).toBeNull();
    await client.listProjects(readOptions);
    const state = client.rateLimitState(SERVICE_AUTH);
    expect(state?.remaining).toBe(42);
    expect(state?.limit).toBe(200);
    expect(state?.resetEpochSeconds).toBe(1_789_000_000);
    expect(state?.observedAt).toBe('2026-09-17T09:00:00.000Z');
  });

  it('keeps one budget per identity', async () => {
    transport
      .queue(
        () =>
          json(200, { count: 0, value: [] }, { 'x-ratelimit-remaining': '10' }),
        () =>
          json(
            200,
            { id: 1, rev: 1, fields: {} },
            {
              'x-ratelimit-remaining': '99',
            },
          ),
      )
      .always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.listProjects(readOptions);
    await client.updateWorkItem(1, [], writeOptions);
    expect(client.rateLimitState(SERVICE_AUTH)?.remaining).toBe(10);
    expect(client.rateLimitState(USER_AUTH)?.remaining).toBe(99);
  });

  it('exposes a cooldown the sync worker can back off on', async () => {
    transport.always(() =>
      json(
        200,
        { count: 0, value: [] },
        { 'x-ratelimit-remaining': '0', 'retry-after': '20' },
      ),
    );
    const { client } = harness(transport);
    await client.listProjects(readOptions);
    expect(client.rateLimitCooldownMs(SERVICE_AUTH)).toBe(20_000);
  });

  it('records the budget from a failing response too', async () => {
    transport.always(() =>
      json(404, { message: 'gone' }, { 'x-ratelimit-remaining': '7' }),
    );
    const { client } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toThrow();
    expect(client.rateLimitState(SERVICE_AUTH)?.remaining).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* Retry and backoff                                                   */
/* ------------------------------------------------------------------ */

describe('retry and backoff', () => {
  it('retries a 429 and honours Retry-After', async () => {
    transport
      .queue(() => json(429, { message: 'throttled' }, { 'retry-after': '3' }))
      .always(() => json(200, { count: 0, value: [] }));
    const { client, slept } = harness(transport);
    await client.listProjects(readOptions);
    expect(slept).toEqual([3_000]);
    expect(transport.requests).toHaveLength(2);
  });

  it('retries a 5xx with exponential backoff when no header is sent', async () => {
    transport
      .queue(
        () => json(503, { message: 'busy' }),
        () => json(503, { message: 'busy' }),
      )
      .always(() => json(200, { count: 0, value: [] }));
    const { client, slept } = harness(transport);
    await client.listProjects(readOptions);
    expect(slept).toEqual([125, 250]);
    expect(transport.requests).toHaveLength(3);
  });

  it('gives up after retrying twice and reports the service is busy', async () => {
    transport.always(() => json(500, { message: 'boom' }));
    const { client, slept } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(transport.requests).toHaveLength(3);
    expect(slept).toHaveLength(2);
  });

  it('carries the attempt count for the roll-back toast', async () => {
    transport.always(() => json(500, { message: 'boom' }));
    const { client } = harness(transport);
    const error = await client
      .listProjects(readOptions)
      .catch((e: unknown) => e);
    expect(isAppError(error) && error.details['attempts']).toBe(3);
  });

  it('surfaces a final 429 as a rate limit error', async () => {
    transport.always(() =>
      json(429, { message: 'throttled' }, { 'retry-after': '1' }),
    );
    const { client } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('never retries a 4xx that is not a 429', async () => {
    transport.always(() => json(403, { message: 'no' }));
    const { client, slept } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('turns a transport timeout into an upstream timeout error', async () => {
    transport.always(() => {
      const error = new Error('headers timeout');
      Object.assign(error, { code: 'UND_ERR_HEADERS_TIMEOUT' });
      throw error;
    });
    const { client } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toBeInstanceOf(
      UpstreamTimeoutError,
    );
    expect(transport.requests).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

describe('response validation', () => {
  it('rejects a shape that does not parse rather than returning it', async () => {
    transport.always(() => json(200, { count: 1, value: [{ name: 'Dev' }] }));
    const { client } = harness(transport);
    await expect(client.listProjects(readOptions)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('unwraps the {count, value} envelope on a good response', async () => {
    transport.always(() =>
      json(200, { count: 1, value: [{ id: 'p1', name: 'Delivery' }] }),
    );
    const { client } = harness(transport);
    await expect(client.listProjects(readOptions)).resolves.toEqual([
      { id: 'p1', name: 'Delivery' },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Batch chunking                                                      */
/* ------------------------------------------------------------------ */

describe('getWorkItemsBatch', () => {
  const workItem = (id: number) => ({ id, rev: 1, fields: {} });

  it('chunks at 200 ids per POST and preserves order', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => index + 1);
    transport.always((request) => {
      const body = JSON.parse(request.body ?? '{}') as { ids: number[] };
      return json(200, {
        count: body.ids.length,
        value: body.ids.map(workItem),
      });
    });
    const { client } = harness(transport);
    const items = await client.getWorkItemsBatch({ ids }, readOptions);
    expect(transport.requests).toHaveLength(3);
    const sizes = transport.requests.map(
      (request) =>
        (JSON.parse(request.body ?? '{}') as { ids: number[] }).ids.length,
    );
    expect(sizes).toEqual([200, 200, 50]);
    expect(items.map((item) => item.id)).toEqual(ids);
  });

  it('carries the requested fields and error policy into every chunk', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);
    transport.always(() => json(200, { count: 0, value: [] }));
    const { client } = harness(transport);
    await client.getWorkItemsBatch(
      { ids, fields: ['System.Id'], errorPolicy: 'omit' },
      readOptions,
    );
    for (const request of transport.requests) {
      const body = JSON.parse(request.body ?? '{}') as {
        fields: string[];
        errorPolicy: string;
      };
      expect(body.fields).toEqual(['System.Id']);
      expect(body.errorPolicy).toBe('omit');
    }
  });

  it('issues the chunks concurrently under the shared bucket', async () => {
    const ids = Array.from({ length: 600 }, (_, index) => index + 1);
    let inFlight = 0;
    let peak = 0;
    const slowTransport = new FakeTransport().always(() =>
      json(200, { count: 0, value: [] }),
    );
    const client = createAdoClient({
      config: CONFIG,
      logger: new FakeLogger(),
      clock: new FakeClock(),
      transport: async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        const response = await slowTransport.send(request);
        inFlight -= 1;
        return response;
      },
      sleep: async () => {},
      random: () => 0,
    });
    await client.getWorkItemsBatch({ ids }, readOptions);
    expect(slowTransport.requests).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('makes no call at all for an empty id list', async () => {
    const { client } = harness(transport);
    await expect(
      client.getWorkItemsBatch({ ids: [] }, readOptions),
    ).resolves.toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

describe('writes', () => {
  it('sends the move patch verbatim as a json-patch document', async () => {
    transport.always(() => json(200, { id: 42, rev: 13, fields: {} }));
    const { client } = harness(transport);
    const patch = buildColumnMovePatch({
      boardId: '4a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
      rev: 12,
      column: 'In Review',
      targetState: 'Active',
    });
    await client.updateWorkItem(42, patch, writeOptions);
    const request = transport.requests[0];
    expect(request?.method).toBe('PATCH');
    expect(request?.url).toContain('/_apis/wit/workitems/42?');
    expect(request?.headers['content-type']).toBe(
      'application/json-patch+json',
    );
    expect(JSON.parse(request?.body ?? 'null')).toEqual([
      { op: 'test', path: '/rev', value: 12 },
      {
        op: 'add',
        path: '/fields/WEF_4A1B2C3D4E5F60718293A4B5C6D7E8F9_Kanban.Column',
        value: 'In Review',
      },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
  });

  it('refuses to write under the service identity', async () => {
    const { client } = harness(transport);
    await expect(
      client.updateWorkItem(42, [], readOptions),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      client.updateTaskboardWorkItem(
        'p',
        't',
        'i',
        1,
        { newColumn: 'Doing' },
        readOptions,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(transport.requests).toHaveLength(0);
  });

  it('moves a taskboard card on the team and iteration endpoint', async () => {
    transport.always(() => json(200, {}));
    const { client } = harness(transport);
    await client.updateTaskboardWorkItem(
      'proj-1',
      'team-a',
      'iter-9',
      77,
      { newColumn: 'In Progress' },
      writeOptions,
    );
    const request = transport.requests[0];
    expect(request?.url).toContain(
      '/proj-1/team-a/_apis/work/taskboardworkitems/iter-9/77?',
    );
    expect(JSON.parse(request?.body ?? 'null')).toEqual({
      newColumn: 'In Progress',
    });
  });

  it('creates one workitem.updated subscription', async () => {
    transport.always((request) =>
      json(200, { ...JSON.parse(request.body ?? '{}'), id: 'sub-1' }),
    );
    const { client } = harness(transport);
    const subscription = await client.createSubscription(
      {
        publisherId: 'tfs',
        eventType: 'workitem.updated',
        consumerId: 'webHooks',
        consumerActionId: 'httpRequest',
        publisherInputs: { projectId: 'proj-1' },
        consumerInputs: { url: 'https://board.example.test/hooks' },
      },
      readOptions,
    );
    expect(subscription.id).toBe('sub-1');
    expect(transport.requests[0]?.url).toContain('/_apis/hooks/subscriptions?');
  });
});

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

describe('logging', () => {
  it('never puts a token or an authorization header in a log line', async () => {
    transport
      .queue(() => json(500, { message: 'boom' }))
      .always(() => json(200, { count: 0, value: [] }));
    const { client, logger } = harness(transport);
    await client.listProjects(readOptions);
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain('service-pat-value');
    expect(serialized).not.toContain('user-access-token');
    expect(serialized).not.toContain('authorization');
  });
});
