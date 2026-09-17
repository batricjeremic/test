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

/**
 * Copied from a live `connectionData` response, backslash and all, rather
 * than invented. An invented fixture is how the api-version bug survived
 * a green suite: the test agreed with the code because both came from the
 * same guess about what Azure DevOps returns.
 */
const connectionData = (over: Record<string, unknown> = {}) => ({
  authenticatedUser: {
    id: '867d7d0d-30c5-6980-addc-083d1b4f3a98',
    subjectDescriptor: 'aad.ODY3ZDdkMGQtMzBjNS03OTgwLWFkZGMtMDgzZDFiNGYzYTk4',
    descriptor:
      'Microsoft.IdentityModel.Claims.ClaimsIdentity;3a7ce086-472b-46b3-aa95-b978c322b880\\nikola.jeremic@expertgroup.rs',
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
    expect(verified.descriptor).toBe(
      'aad.ODY3ZDdkMGQtMzBjNS03OTgwLWFkZGMtMDgzZDFiNGYzYTk4',
    );
    expect(verified.id).toBe('867d7d0d-30c5-6980-addc-083d1b4f3a98');
    expect(request).toHaveBeenCalledTimes(1);
    // The -preview flag is load-bearing: without it Azure DevOps answers
    // 400 and every sign-in fails. This assertion was written from belief
    // once already and pinned the wrong version; the value below is copied
    // from a live call, not from the documentation.
    expect(request.mock.calls[0]?.[0].url).toBe(
      'https://dev.azure.com/expertgroup/_apis/connectionData?api-version=7.1-preview',
    );
  });

  it('falls back to the legacy descriptor when there is no modern one', async () => {
    const { verifier } = build(async () => ({
      status: 200,
      body: connectionData({ subjectDescriptor: undefined }),
    }));

    const verified = await verifier.verify('opaque-token', CALL);

    expect(verified.descriptor).toBe(
      'Microsoft.IdentityModel.Claims.ClaimsIdentity;3a7ce086-472b-46b3-aa95-b978c322b880\\nikola.jeremic@expertgroup.rs',
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

  // The bug that got to production: connectionData is a preview resource,
  // so a plain api-version=7.1 is refused with a 400 and every sign-in
  // fails. From outside it is indistinguishable from an outage, so the log
  // has to say whose fault it is.
  it('names a 4xx as our request being wrong, not an outage', async () => {
    const errors: string[] = [];
    const logger = silentLogger();
    (logger as { error: (message: string) => void }).error = (message) => {
      errors.push(message);
    };
    const { verifier } = build(async () => ({ status: 400, body: {} }), {
      logger,
    });

    await expect(verifier.verify('fine', CALL)).rejects.toSatisfy(
      (error: unknown) =>
        isTokenRejected(error) &&
        error.rejection === 'introspection-unavailable',
    );
    expect(errors).toContain('token introspection request is wrong');
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
