/**
 * Reads under the service identity, writes under the caller's own. The
 * tests are here so the two can never quietly swap places.
 */
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '../errors.js';
import type { CallOptions, CallerIdentity } from '../ports.js';
import {
  assertCanWriteProject,
  canReadProject,
  canWriteProject,
  isServiceAuth,
  isUserAuth,
  requireUserAuth,
  serviceCallOptions,
  serviceReadAuth,
  userAuth,
  userCallOptions,
} from './identity.js';
import { TEST_DESCRIPTOR, makeAcl } from './test-support.js';

const identity: CallerIdentity = {
  descriptor: TEST_DESCRIPTOR,
  id: 'identity-guid',
  accessToken: 'user-token',
};

const options: CallOptions = { traceId: 'trace-identity', timeoutMs: 5_000 };

describe('identity accessors', () => {
  it('gives reads the service identity and no token', () => {
    const auth = serviceReadAuth();

    expect(auth.kind).toBe('service');
    expect(isServiceAuth(auth)).toBe(true);
    expect(JSON.stringify(auth)).not.toContain('user-token');
  });

  it('gives writes the caller token and descriptor', () => {
    const auth = userAuth(identity);

    expect(isUserAuth(auth)).toBe(true);
    if (!isUserAuth(auth)) return;
    expect(auth.accessToken).toBe('user-token');
    expect(auth.descriptor).toBe(TEST_DESCRIPTOR);
  });

  it('keeps the trace id and timeout on both call option shapes', () => {
    expect(serviceCallOptions(options)).toEqual({
      traceId: 'trace-identity',
      timeoutMs: 5_000,
      auth: { kind: 'service' },
    });
    expect(userCallOptions(identity, options).timeoutMs).toBe(5_000);
    expect(userCallOptions(identity, options).auth.kind).toBe('user');
  });

  it('refuses a write under the service identity', () => {
    expect(() => requireUserAuth(serviceReadAuth(), 'updateWorkItem')).toThrow(
      PermissionDeniedError,
    );
    expect(requireUserAuth(userAuth(identity), 'updateWorkItem').kind).toBe(
      'user',
    );
  });
});

describe('project permission helpers', () => {
  const acl = makeAcl({
    readableProjectIds: ['Delivery', 'Platform'],
    writableProjectIds: ['Delivery'],
  });

  it('reads and writes are separate questions', () => {
    expect(canReadProject(acl, 'Platform')).toBe(true);
    expect(canWriteProject(acl, 'Platform')).toBe(false);
    expect(canWriteProject(acl, 'Delivery')).toBe(true);
    expect(canReadProject(acl, 'Secret')).toBe(false);
  });

  it('denies a write in a read-only project', () => {
    expect(() => assertCanWriteProject(acl, 'Delivery', 'move')).not.toThrow();
    expect(() => assertCanWriteProject(acl, 'Platform', 'move')).toThrow(
      PermissionDeniedError,
    );
    expect(() => assertCanWriteProject(acl, 'Secret', 'move')).toThrow(
      PermissionDeniedError,
    );
  });
});
