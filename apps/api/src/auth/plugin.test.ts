/**
 * The request hook. Fastify is real here — it is cheap, and the point of
 * the test is the lifecycle — but the verifier and the ACL resolver are
 * fakes, so nothing leaves the process.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isAppError, UpstreamError } from '../errors.js';
import type {
  AclResolver,
  CallOptions,
  CallerAcl,
  CallerIdentity,
} from '../ports.js';
import { TokenRejectedError, type TokenVerifier } from './token.js';
import {
  registerAuth,
  requireAcl,
  requireAuth,
  traceIdFromHeaders,
} from './plugin.js';
import { RecordingLogger, TEST_DESCRIPTOR, makeAcl } from './test-support.js';

/** The app's own error handler, so a thrown AppError keeps its status. */
const statusOf = (error: unknown): number =>
  isAppError(error) ? error.status : 500;

const acl = makeAcl({
  readableProjectIds: ['Delivery'],
  writableProjectIds: ['Delivery'],
});

class FakeVerifier implements TokenVerifier {
  readonly tokens: string[] = [];
  reject: TokenRejectedError | null = null;

  async verify(token: string, _options: CallOptions) {
    this.tokens.push(token);
    if (this.reject !== null) throw this.reject;
    return {
      descriptor: TEST_DESCRIPTOR,
      id: 'identity-guid',
      expiresAt: new Date('2026-09-17T10:00:00Z'),
      issuedAt: new Date('2026-09-17T09:00:00Z'),
      scopes: ['vso.work_write'],
    };
  }
}

class FakeAclResolver implements AclResolver {
  calls = 0;
  failure: Error | null = null;
  readonly identities: CallerIdentity[] = [];
  readonly invalidated: string[] = [];

  async resolve(
    identity: CallerIdentity,
    _options: CallOptions,
  ): Promise<CallerAcl> {
    this.calls += 1;
    this.identities.push(identity);
    if (this.failure !== null) throw this.failure;
    return acl;
  }

  async invalidate(descriptor: string, _options: CallOptions): Promise<void> {
    this.invalidated.push(descriptor);
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly verifier: FakeVerifier;
  readonly resolver: FakeAclResolver;
  readonly logger: RecordingLogger;
}

async function harness(): Promise<Harness> {
  const app = Fastify();
  const verifier = new FakeVerifier();
  const resolver = new FakeAclResolver();
  const logger = new RecordingLogger();

  registerAuth(app, {
    verifier,
    acl: resolver,
    logger,
    aclTimeoutMs: 4_000,
    isExempt: (request) => request.url.startsWith('/healthz'),
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/me', async (request) => {
    const context = requireAuth(request);
    return {
      descriptor: context.identity.descriptor,
      traceId: context.traceId,
      scopes: context.scopes,
      timeoutMs: context.callOptions().timeoutMs,
    };
  });

  app.get('/board', async (request) => {
    const first = await requireAcl(request);
    const second = await requireAcl(request);
    return {
      same: first === second,
      readable: first.readableProjectIds,
    };
  });

  app.setErrorHandler(async (error, _request, reply) => {
    return await reply.code(statusOf(error)).send({ failed: true });
  });

  await app.ready();
  return { app, verifier, resolver, logger };
}

describe('registerAuth', () => {
  it('rejects a request with no Authorization header', async () => {
    const { app } = await harness();

    const response = await app.inject({ method: 'GET', url: '/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: 'unauthorized',
      message: 'Please sign in again.',
      status: 401,
    });
    await app.close();
  });

  it('rejects an expired token with the same opaque body', async () => {
    const { app, verifier } = await harness();
    verifier.reject = new TokenRejectedError('expired');

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer expired-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized' });
    expect(JSON.stringify(response.json())).not.toContain('expired-token');
    await app.close();
  });

  it('attaches the identity, the scopes and the trace id', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer good-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      descriptor: TEST_DESCRIPTOR,
      scopes: ['vso.work_write'],
      timeoutMs: 4_000,
    });
    await app.close();
  });

  it('adopts a caller trace id and echoes it back', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: 'Bearer good-token',
        'x-trace-id': 'trace-from-hub',
      },
    });

    expect(response.headers['x-trace-id']).toBe('trace-from-hub');
    expect(response.json()).toMatchObject({ traceId: 'trace-from-hub' });
    await app.close();
  });

  it('echoes a generated trace id even on a rejection', async () => {
    const { app } = await harness();

    const response = await app.inject({ method: 'GET', url: '/me' });

    const traceId = response.headers['x-trace-id'];
    expect(typeof traceId).toBe('string');
    expect(response.json()).toMatchObject({ traceId });
    await app.close();
  });

  it('resolves the ACL once per request, however often it is asked', async () => {
    const { app, resolver } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/board',
      headers: { authorization: 'Bearer good-token' },
    });

    expect(response.json()).toEqual({ same: true, readable: ['Delivery'] });
    expect(resolver.calls).toBe(1);
    await app.close();
  });

  it('passes the caller token to the resolver, and logs neither', async () => {
    const { app, resolver, logger } = await harness();

    await app.inject({
      method: 'GET',
      url: '/board',
      headers: { authorization: 'Bearer secret-user-token' },
    });

    expect(resolver.identities[0]?.accessToken).toBe('secret-user-token');
    expect(
      logger.everyValue().some((value) => value.includes('secret-user-token')),
    ).toBe(false);
    await app.close();
  });

  it('serves nothing when the ACL cannot be resolved', async () => {
    const { app, resolver } = await harness();
    resolver.failure = new UpstreamError('azure devops is down', 502);

    const response = await app.inject({
      method: 'GET',
      url: '/board',
      headers: { authorization: 'Bearer good-token' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ failed: true });
    await app.close();
  });

  it('lets an exempt route through without a token', async () => {
    const { app, verifier } = await harness();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(verifier.tokens).toEqual([]);
    await app.close();
  });
});

describe('requireAuth', () => {
  it('refuses a request the hook did not authenticate', async () => {
    const app = Fastify();
    app.get('/unguarded', async (request) => requireAuth(request));
    app.setErrorHandler(async (error, _request, reply) => {
      return await reply.code(statusOf(error)).send({ failed: true });
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/unguarded' });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('traceIdFromHeaders', () => {
  it('prefers x-trace-id, then x-request-id', () => {
    expect(
      traceIdFromHeaders({
        'x-trace-id': 'trace-aaaaaaaa',
        'x-request-id': 'request-bbbbbbb',
      }),
    ).toBe('trace-aaaaaaaa');
    expect(traceIdFromHeaders({ 'x-request-id': 'request-bbbbbbb' })).toBe(
      'request-bbbbbbb',
    );
  });

  it('generates one rather than trusting a hostile value', () => {
    const generated = traceIdFromHeaders({ 'x-trace-id': 'no' });
    expect(generated).not.toBe('no');
    expect(generated.length).toBeGreaterThan(8);

    const injected = traceIdFromHeaders({
      'x-trace-id': 'trace\n{"level":"fatal"}',
    });
    expect(injected).not.toContain('\n');
  });
});
