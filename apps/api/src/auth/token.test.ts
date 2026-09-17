/**
 * Token validation. Signed with a key pair generated in-process, so the
 * crypto is real and no JWKS endpoint is ever contacted.
 */
import { describe, expect, it } from 'vitest';
import type { JWTVerifyGetKey } from 'jose';
import { SignJWT, importJWK } from 'jose';
import { UnauthorizedError } from '../errors.js';
import type { CallOptions } from '../ports.js';
import {
  createTokenVerifier,
  extractBearerToken,
  identityLogFields,
  isTokenRejected,
  toCallerIdentity,
  type TokenVerifier,
} from './token.js';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  TestClock,
  generateTestKey,
  signTestToken,
  type TestKeyMaterial,
} from './test-support.js';

const options: CallOptions = { traceId: 'trace-token' };
const key = await generateTestKey();
const otherKey = await generateTestKey('other-key');

/** Serves exactly the one key, as a JWKS with a matching `kid` would. */
function keyResolver(material: TestKeyMaterial): JWTVerifyGetKey {
  return async () => await importJWK(material.publicJwk, 'RS256');
}

function verifier(
  overrides: {
    clock?: TestClock;
    audience?: string;
    issuer?: string;
    material?: TestKeyMaterial;
  } = {},
): TokenVerifier {
  return createTokenVerifier({
    issuer: overrides.issuer ?? TEST_ISSUER,
    audience: overrides.audience ?? TEST_AUDIENCE,
    keyResolver: keyResolver(overrides.material ?? key),
    clock: overrides.clock ?? new TestClock(),
  });
}

describe('createTokenVerifier', () => {
  it('accepts a well-formed token and extracts the descriptor', async () => {
    const token = await signTestToken({
      key,
      descriptor: 'aad.YW5h',
      scopes: 'vso.work_write vso.project',
    });

    const verified = await verifier().verify(token, options);

    expect(verified.descriptor).toBe('aad.YW5h');
    expect(verified.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(verified.scopes).toEqual(['vso.work_write', 'vso.project']);
    expect(verified.expiresAt.toISOString()).toBe('2026-09-17T10:00:00.000Z');
  });

  it('rejects an expired token', async () => {
    const token = await signTestToken({
      key,
      issuedAt: new Date('2026-09-17T06:00:00Z'),
      expiresAt: new Date('2026-09-17T07:00:00Z'),
    });

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      rejection: 'expired',
    });
  });

  it('rejects a token minted for another audience', async () => {
    const token = await signTestToken({ key, audience: 'some-other-service' });

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      rejection: 'wrong-audience',
    });
  });

  it('rejects a token from another issuer', async () => {
    const token = await signTestToken({ key, issuer: 'https://evil.example' });

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      rejection: 'wrong-issuer',
    });
  });

  it('rejects a token signed with a key we do not trust', async () => {
    const token = await signTestToken({ key: otherKey });

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      rejection: 'bad-signature',
    });
  });

  it('rejects a token that is not a token at all', async () => {
    await expect(
      verifier().verify('not.a.jwt', options),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verifier().verify('   ', options)).rejects.toMatchObject({
      rejection: 'missing',
    });
  });

  it('rejects a token with no identity descriptor claim', async () => {
    const token = await signTestToken({ key, descriptor: null });

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      rejection: 'claims-invalid',
    });
  });

  it('leaks nothing to the caller when it rejects', async () => {
    const token = await signTestToken({
      key,
      descriptor: 'aad.YW5h',
      expiresAt: new Date('2026-09-17T07:00:00Z'),
      issuedAt: new Date('2026-09-17T06:00:00Z'),
    });

    const error = await verifier()
      .verify(token, options)
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(isTokenRejected(error)).toBe(true);
    if (!isTokenRejected(error)) return;
    const body = error.toApiError('trace-token');
    expect(body).toEqual({
      code: 'unauthorized',
      message: 'Please sign in again.',
      status: 401,
      traceId: 'trace-token',
    });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain('aad.YW5h');
  });

  it('expires against the injected clock, not the wall clock', async () => {
    const clock = new TestClock('2026-09-17T09:00:00.000Z');
    const token = await signTestToken({ key });
    const subject = verifier({ clock });

    await expect(subject.verify(token, options)).resolves.toBeDefined();
    clock.advance(2 * 60 * 60 * 1000);
    await expect(subject.verify(token, options)).rejects.toMatchObject({
      rejection: 'expired',
    });
  });

  it('refuses a token with no expiry at all', async () => {
    const token = await new SignJWT({ descriptor: 'aad.YW5h' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setSubject('11111111-2222-3333-4444-555555555555')
      .setIssuedAt(Math.floor(Date.parse('2026-09-17T09:00:00Z') / 1000))
      .sign(key.privateKey);

    await expect(verifier().verify(token, options)).rejects.toMatchObject({
      rejection: 'claims-invalid',
    });
  });

  it('needs a key source', () => {
    expect(() =>
      createTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE }),
    ).toThrow(TypeError);
  });
});

describe('identity plumbing', () => {
  it('carries the raw bearer for the write path and nothing else', async () => {
    const token = await signTestToken({ key, descriptor: 'aad.YW5h' });
    const verified = await verifier().verify(token, options);

    const identity = toCallerIdentity(verified, token);

    expect(identity).toEqual({
      descriptor: 'aad.YW5h',
      id: '11111111-2222-3333-4444-555555555555',
      accessToken: token,
    });
  });

  it('logs descriptors and ids, never the token', async () => {
    const token = await signTestToken({ key, descriptor: 'aad.YW5h' });
    const verified = await verifier().verify(token, options);

    const fields = identityLogFields(verified);

    expect(fields['descriptor']).toBe('aad.YW5h');
    expect(JSON.stringify(fields)).not.toContain(token);
  });
});

describe('extractBearerToken', () => {
  it('reads the scheme case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc')).toBe('abc');
    expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });

  it('returns null for anything else', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer    ')).toBeNull();
  });
});
