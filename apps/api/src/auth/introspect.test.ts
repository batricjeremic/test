import { describe, expect, it, vi } from 'vitest';
import { createIntrospectionVerifier } from './introspect.js';
import type { IntrospectionRequest } from './introspect.js';
import { isTokenRejected } from './token.js';
import type { Clock, Logger } from '../ports.js';

const silentLogger = (): Logger => {
  const logger: Logger = {
    child: () => logger,
    withTraceId: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  return logger;
};

const fixedClock = (
  start = new Date('2026-09-17T12:00:00Z'),
): Clock & {
  advance: (ms: number) => void;
} => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
};

const CALL = { traceId: 'trace-1' };

const connectionData = (over: Record<string, unknown> = {}) => ({
  authenticatedUser: {
    id: '867d7d0d-30c5-6980-addc-083d1b4f3a98',
    subjectDescriptor: 'aad.YmFzZTY0LWRlc2NyaXB0b3I',
    descriptor: 'Microsoft.IdentityModel.Claims.ClaimsIdentity;legacy',
    ...over,
  },
});

const build = (
  request: IntrospectionRequest,
  extra: Partial<Parameters<typeof createIntrospectionVerifier>[0]> = {},
) => {
  const clock = fixedClock();
  const verifier = createIntrospectionVerifier({
    orgUrl: 'https://dev.azure.com/expertgroup/',
    request,
    clock,
    logger: silentLogger(),
    ...extra,
  });
  return { verifier, clock };
};

describe('createIntrospectionVerifier', () => {
  it('accepts a token Azure DevOps recognises and returns its descriptor', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: connectionData(),
    }));
    const { verifier } = build(request);

    const verified = await verifier.verify('opaque-token', CALL);

    // The modern descriptor wins: it is the one System.AssignedTo returns.
    expect(verified.descriptor).toBe('aad.YmFzZTY0LWRlc2NyaXB0b3I');
    expect(verified.id).toBe('867d7d0d-30c5-6980-addc-083d1b4f3a98');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].url).toBe(
      'https://dev.azure.com/expertgroup/_apis/connectionData?api-version=7.1',
    );
  });

  it('falls back to the legacy descriptor when there is no modern one', async () => {
    const { verifier } = build(async () => ({
      status: 200,
      body: connectionData({ subjectDescriptor: undefined }),
    }));

    const verified = await verifier.verify('opaque-token', CALL);

    expect(verified.descriptor).toBe(
      'Microsoft.IdentityModel.Claims.ClaimsIdentity;legacy',
    );
  });

  // The failure that sent us here: the token is not a JWT, so a local parse
  // rejected it as malformed before Azure DevOps was ever consulted.
  it('does not care that the token is not a JWT', async () => {
    const { verifier } = build(async () => ({
      status: 200,
      body: connectionData(),
    }));

    await expect(
      verifier.verify('not.a.jwt-at-all', CALL),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('refuses a token Azure DevOps rejects, and says which it was', async () => {
    const { verifier } = build(async () => ({ status: 401, body: {} }));

    await expect(verifier.verify('stale', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) && error.rejection === 'rejected-by-issuer',
    );
  });

  // An outage is not a bad caller. Merging them would have us tell a
  // signed-in person to sign in again while Azure DevOps is down.
  it('separates an outage from a rejection', async () => {
    const { verifier } = build(async () => ({ status: 503, body: {} }));

    await expect(verifier.verify('fine', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) &&
        error.rejection === 'introspection-unavailable',
    );
  });

  it('treats a thrown request as unavailable rather than as a refusal', async () => {
    const { verifier } = build(async () => {
      throw new Error('socket hang up');
    });

    await expect(verifier.verify('fine', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) &&
        error.rejection === 'introspection-unavailable',
    );
  });

  // Azure DevOps answers 200 for an anonymous caller too, with no
  // descriptor. Accepting that would sign in nobody as somebody.
  it('refuses a 200 that carries no descriptor', async () => {
    const { verifier } = build(async () => ({
      status: 200,
      body: {
        authenticatedUser: { id: 'anonymous-id' },
      },
    }));

    await expect(verifier.verify('anon', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) && error.rejection === 'claims-invalid',
    );
  });

  it('refuses a body that is not connectionData at all', async () => {
    const { verifier } = build(async () => ({
      status: 200,
      body: { something: 'else' },
    }));

    await expect(verifier.verify('odd', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) && error.rejection === 'claims-invalid',
    );
  });

  it('refuses an empty token without calling out at all', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: connectionData(),
    }));
    const { verifier } = build(request);

    await expect(verifier.verify('', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) && error.rejection === 'missing',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('asks once per token within the trust window, and again after it', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: connectionData(),
    }));
    const { verifier, clock } = build(request, { ttlMs: 60_000 });

    await verifier.verify('same-token', CALL);
    await verifier.verify('same-token', CALL);
    expect(request).toHaveBeenCalledTimes(1);

    clock.advance(61_000);
    await verifier.verify('same-token', CALL);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not let one caller answer for another', async () => {
    let id = 0;
    const { verifier } = build(async () => {
      id += 1;
      return {
        status: 200,
        body: connectionData({ subjectDescriptor: `aad.person-${id}` }),
      };
    });

    const first = await verifier.verify('token-a', CALL);
    const second = await verifier.verify('token-b', CALL);

    expect(first.descriptor).not.toBe(second.descriptor);
  });

  it('bounds the cache rather than growing it forever', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: connectionData(),
    }));
    const { verifier } = build(request, { maxCached: 2 });

    await verifier.verify('t1', CALL);
    await verifier.verify('t2', CALL);
    await verifier.verify('t3', CALL);
    expect(request).toHaveBeenCalledTimes(3);

    // t1 was evicted to make room, so it has to be asked again.
    await verifier.verify('t1', CALL);
    expect(request).toHaveBeenCalledTimes(4);
  });
});
