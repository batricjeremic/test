/**
 * Validating the hub's token by asking Azure DevOps who it belongs to.
 *
 * The spec says "the BFF validates it against the Azure DevOps issuer and
 * extracts the caller's identity descriptor". `token.ts` reads that as a
 * local JWT verification against a JWKS, which is the usual shape — and
 * it is wrong for this token. What `SDK.getAccessToken()` hands the hub
 * is not a JWT we can parse: the first real browser request was rejected
 * with `reason: "malformed"` before any issuer or audience was examined.
 *
 * So we validate the way this token is meant to be validated: we spend it.
 * A call to `_apis/connectionData` carrying it as a bearer either comes
 * back with the authenticated identity, which is proof the token is good
 * AND the descriptor we need in one round trip, or it does not, and the
 * caller is refused. Azure DevOps remains the issuer doing the deciding;
 * we ask it rather than re-derive its answer.
 *
 * The same rules as the JWT path still hold: an explicit timeout, a Zod
 * parse at the boundary, a reason in the log and never in the response,
 * and the token itself never logged, never cached, never stored.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Descriptor } from '@eg/shared';
import type { CallOptions, Clock, Logger } from '../ports.js';
import { TokenRejectedError, type VerifiedToken } from './token.js';
import type { TokenVerifier } from './token.js';

/**
 * Azure DevOps answers this with the caller it recognises.
 *
 * `-preview` is not optional and not cosmetic: `connectionData` is still a
 * preview resource, and a plain `api-version=7.1` is refused with a 400
 * telling you to supply the flag. We shipped it without, every request came
 * back `introspection-unavailable`, and the test that pinned this URL pinned
 * the wrong version because it was written from the same belief as the code.
 */
export const CONNECTION_DATA_PATH =
  '_apis/connectionData?api-version=7.1-preview';

/** An introspection result is trusted this long before it is re-checked. */
export const DEFAULT_INTROSPECTION_TTL_MS = 5 * 60_000;
/** Explicit, because an unbounded call would hang every request. */
export const DEFAULT_INTROSPECTION_TIMEOUT_MS = 5_000;
/** Bounds the cache so a flood of distinct tokens cannot grow it forever. */
export const DEFAULT_MAX_CACHED_IDENTITIES = 5_000;

/**
 * `subjectDescriptor` is the modern descriptor and the one that matches
 * `System.AssignedTo`; `descriptor` is its legacy form, kept as a
 * fallback for organisations that still return only that.
 */
const connectionDataSchema = z.object({
  authenticatedUser: z.object({
    id: z.string().min(1),
    descriptor: z.string().min(1).optional(),
    subjectDescriptor: z.string().min(1).optional(),
  }),
});

/** The one HTTP call this module makes, injectable so tests need no network. */
export type IntrospectionRequest = (input: {
  readonly url: string;
  readonly token: string;
  readonly signal: AbortSignal;
}) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface IntrospectionVerifierOptions {
  /** `https://dev.azure.com/<org>`, no trailing slash. */
  readonly orgUrl: string;
  readonly request: IntrospectionRequest;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly maxCached?: number;
}

/** Tokens are never stored — only an unkeyed digest of one. */
const fingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');

export function createIntrospectionVerifier(
  options: IntrospectionVerifierOptions,
): TokenVerifier {
  const ttlMs = options.ttlMs ?? DEFAULT_INTROSPECTION_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTROSPECTION_TIMEOUT_MS;
  const maxCached = options.maxCached ?? DEFAULT_MAX_CACHED_IDENTITIES;
  const url = `${options.orgUrl.replace(/\/+$/, '')}/${CONNECTION_DATA_PATH}`;

  const cache = new Map<string, VerifiedToken>();

  const remember = (key: string, verified: VerifiedToken): void => {
    // Oldest first: Map preserves insertion order, so the first key is the
    // least recently added.
    if (cache.size >= maxCached) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, verified);
  };

  return {
    async verify(token: string, callOptions: CallOptions) {
      if (token.length === 0) {
        throw new TokenRejectedError('missing', {
          details: { reason: 'no bearer token' },
        });
      }

      const key = fingerprint(token);
      const cached = cache.get(key);
      if (
        cached &&
        cached.expiresAt.getTime() > options.clock.now().getTime()
      ) {
        return cached;
      }
      cache.delete(key);

      const controller = new AbortController();
      const budget = callOptions.timeoutMs ?? timeoutMs;
      const timer = setTimeout(() => controller.abort(), budget);

      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await options.request({
          url,
          token,
          signal: controller.signal,
        }));
      } catch (error) {
        options.logger.warn('token introspection failed', {
          traceId: callOptions.traceId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        throw new TokenRejectedError('introspection-unavailable', {
          details: { reason: 'Azure DevOps did not answer' },
        });
      } finally {
        clearTimeout(timer);
      }

      if (status === 401 || status === 403) {
        throw new TokenRejectedError('rejected-by-issuer', {
          details: { status },
        });
      }
      if (status < 200 || status >= 300) {
        // A 4xx that is not 401/403 is Azure DevOps refusing the REQUEST,
        // not the caller: a wrong api-version, a wrong path, a wrong org.
        // That is our bug, and it looks exactly like an outage from the
        // outside, so it gets a log line that says whose fault it is —
        // the 400 on a missing `-preview` flag cost us a deploy to find.
        if (status >= 400 && status < 500) {
          options.logger.error('token introspection request is wrong', {
            traceId: callOptions.traceId,
            status,
            url,
          });
        }
        throw new TokenRejectedError('introspection-unavailable', {
          details: { status },
        });
      }

      const parsed = connectionDataSchema.safeParse(body);
      if (!parsed.success) {
        throw new TokenRejectedError('claims-invalid', {
          details: { reason: 'no authenticated user in connectionData' },
        });
      }

      const user = parsed.data.authenticatedUser;
      const descriptor = user.subjectDescriptor ?? user.descriptor;
      if (descriptor === undefined) {
        // Anonymous callers come back 200 with no descriptor at all, which
        // would otherwise read as a successful sign-in.
        throw new TokenRejectedError('claims-invalid', {
          details: { reason: 'no descriptor for the caller' },
        });
      }

      const now = options.clock.now();
      const verified: VerifiedToken = {
        descriptor: descriptor as Descriptor,
        id: user.id,
        // Introspection does not report the token's own expiry, so we
        // vouch for it only as long as we are willing to skip re-asking.
        expiresAt: new Date(now.getTime() + ttlMs),
        issuedAt: now,
        // Nor does it report scopes. The manifest declares them and Azure
        // DevOps enforces them on the calls we make; nothing here reads
        // them, and inventing a value would be worse than an empty one.
        scopes: [],
      };
      remember(key, verified);
      return verified;
    },
  };
}

/**
 * The real HTTP call, on undici, with the same timeout discipline as
 * every other outbound call in the service.
 */
export function createUndiciIntrospectionRequest(): IntrospectionRequest {
  return async ({ url, token, signal }) => {
    const { request } = await import('undici');
    const response = await request(url, {
      method: 'GET',
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    // A non-JSON body is not an error here: the status decides, and the
    // Zod parse above rejects anything that is not connectionData.
    let body: unknown = null;
    try {
      body = await response.body.json();
    } catch {
      await response.body.dump();
    }
    return { status: response.statusCode, body };
  };
}
