/**
 * Which identity a call runs under, made impossible to confuse.
 *
 * Spec, "Caching, rate limits and realtime": "Reads go through a service
 * identity with a warm cache; writes go through the user's own identity.
 * That split is the single most consequential decision in the backend."
 * Writes must carry the caller's token or the Boards history attributes
 * every change to a service account.
 *
 * So there is no general `authFor(...)`. There are two named accessors,
 * one per purpose, and a write path that refuses anything but a user
 * identity. A call site therefore says which identity it means, and the
 * wrong one is a type error or an immediate throw rather than a subtly
 * wrong audit trail.
 *
 * `CallerIdentity.accessToken` is a secret: it is placed on the outbound
 * request and never anywhere else, least of all a log line.
 */
import type { Descriptor } from '@eg/shared';
import { PermissionDeniedError } from '../errors.js';
import type {
  AdoAuth,
  AdoCallOptions,
  CallOptions,
  CallerAcl,
  CallerIdentity,
} from '../ports.js';

/**
 * The service identity. Bulk reads only: many users share one cache and
 * one rate-limit budget, which is what makes the board fast.
 *
 * Never pass this to a write. A write under the service identity is a
 * falsified audit trail in Azure DevOps, not a permissions bug.
 */
export function serviceReadAuth(): AdoAuth {
  return { kind: 'service' };
}

/**
 * The caller's own identity. Used for writes, so Boards history and
 * notifications attribute the change to the person who made it, and for
 * the ACL probe in `./acl.js`, where the whole point is that Azure
 * DevOps answers as that user.
 */
export function userAuth(identity: CallerIdentity): AdoAuth {
  return {
    kind: 'user',
    accessToken: identity.accessToken,
    descriptor: identity.descriptor,
  };
}

export function isUserAuth(
  auth: AdoAuth,
): auth is Extract<AdoAuth, { kind: 'user' }> {
  return auth.kind === 'user';
}

export function isServiceAuth(
  auth: AdoAuth,
): auth is Extract<AdoAuth, { kind: 'service' }> {
  return auth.kind === 'service';
}

/**
 * Guards the write path. `AdoClient.updateWorkItem` and
 * `updateTaskboardWorkItem` require a user identity; this turns "we
 * forgot" into a refusal before the request leaves the process.
 */
export function requireUserAuth(
  auth: AdoAuth,
  operation: string,
): Extract<AdoAuth, { kind: 'user' }> {
  if (!isUserAuth(auth)) {
    throw new PermissionDeniedError(
      `${operation} requires the caller's own identity, not the service one`,
      { details: { operation } },
    );
  }
  return auth;
}

/** Azure DevOps options for a cached bulk read, under the service token. */
export function serviceCallOptions(options: CallOptions): AdoCallOptions {
  return { ...options, auth: serviceReadAuth() };
}

/** Azure DevOps options for a write, under the caller's own token. */
export function userCallOptions(
  identity: CallerIdentity,
  options: CallOptions,
): AdoCallOptions {
  return { ...options, auth: userAuth(identity) };
}

/** True when the ACL lets this caller write in that project. */
export function canWriteProject(acl: CallerAcl, projectId: string): boolean {
  return acl.writableProjectIds.includes(projectId);
}

/** True when the ACL lets this caller read that project at all. */
export function canReadProject(acl: CallerAcl, projectId: string): boolean {
  return acl.readableProjectIds.includes(projectId);
}

/**
 * The write-path gate. A caller who cannot read the project is told the
 * same thing as one who can read but not write: "permission denied",
 * with no hint about what is in there.
 */
export function assertCanWriteProject(
  acl: CallerAcl,
  projectId: string,
  operation: string,
): void {
  if (canWriteProject(acl, projectId)) return;
  throw new PermissionDeniedError(
    `${operation} denied: caller may not write in project ${projectId}`,
    { details: { operation, projectId } },
  );
}

/** Descriptor of the identity an ACL belongs to. Never a display name. */
export function aclDescriptor(acl: CallerAcl): Descriptor {
  return acl.descriptor;
}
