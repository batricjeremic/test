/**
 * Validating the token the hub obtained from `SDK.getAccessToken()`.
 *
 * Spec, "Auth, permissions and security": the hub sends that token on
 * every request; "the BFF validates it against the Azure DevOps issuer
 * and extracts the caller's identity descriptor".
 *
 * Four properties this module is responsible for:
 *
 * - signature, issuer, audience and expiry are all checked, never just
 *   the signature;
 * - the JWKS fetch has an explicit timeout and a bounded cache, per the
 *   ExpertGroup rule that no outbound call is unbounded;
 * - every claim is read through a Zod parse, because a token payload is
 *   a process boundary like any other;
 * - a rejected token produces a 401 whose body says only "please sign in
 *   again". The reason lives in the log line, never in the response, and
 *   the token itself is never placed in either.
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWSAlgorithm,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import type { Descriptor } from '@eg/shared';
import { UnauthorizedError, type AppErrorOptions } from '../errors.js';
import type { CallOptions, CallerIdentity, Clock } from '../ports.js';

/**
 * Azure DevOps mints the hub's token; these are its defaults. They are
 * options rather than constants because which issuer signs the token
 * depends on how the organisation is backed (a VSTS-issued token and an
 * Entra-issued one differ), and a deployment must be able to say so
 * without a code change.
 */
export const ADO_TOKEN_ISSUER = 'https://app.vstoken.visualstudio.com';
export const ADO_TOKEN_JWKS_URI =
  'https://app.vstoken.visualstudio.com/_apis/token/keys';
/** Azure DevOps' well-known resource id, the audience of its tokens. */
export const ADO_RESOURCE_AUDIENCE = '499b84ac-1321-427f-aa17-267ca6975798';

/** Signature algorithms we accept. Asymmetric only: never `none`, never HS. */
export const DEFAULT_TOKEN_ALGORITHMS: readonly JWSAlgorithm[] = [
  'RS256',
  'RS384',
  'RS512',
];

/** Explicit timeout on the JWKS fetch. */
export const DEFAULT_JWKS_TIMEOUT_MS = 3_000;
/** How long a fetched key set is trusted before it is refreshed. */
export const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
/** Floor between fetches when an unknown `kid` arrives, to resist a flood. */
export const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
/** Tolerance for clock skew between us and the issuer. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Claims that may carry the Azure DevOps identity descriptor, in order
 * of preference. A descriptor is what the rest of the service keys on:
 * "within one Azure DevOps organization, `System.AssignedTo` returns the
 * same identity descriptor ... in every project".
 */
export const DEFAULT_DESCRIPTOR_CLAIMS: readonly string[] = [
  'descriptor',
  'ado_descriptor',
  'http://schemas.microsoft.com/identity/claims/descriptor',
];

/** Claims that may carry the identity GUID, in order of preference. */
export const DEFAULT_IDENTITY_ID_CLAIMS: readonly string[] = [
  'nameid',
  'oid',
  'sub',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
];

/**
 * The claims we read. Everything else in the payload is ignored rather
 * than trusted. `.passthrough()` keeps the unknown keys around so a
 * configured descriptor claim can still be looked up by name.
 */
export const adoTokenClaimsSchema = z
  .object({
    iss: z.string().min(1).optional(),
    sub: z.string().min(1).optional(),
    exp: z.number().finite(),
    iat: z.number().finite().optional(),
    nbf: z.number().finite().optional(),
    scp: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

export type AdoTokenClaims = z.infer<typeof adoTokenClaimsSchema>;

const claimBagSchema = z.record(z.unknown());

/** What validation yields. Deliberately not the whole payload. */
export interface VerifiedToken {
  readonly descriptor: Descriptor;
  /** The identity GUID, for Azure DevOps calls that want an id. */
  readonly id: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date | null;
  /** OAuth scopes the token carries, e.g. `vso.work_write`. */
  readonly scopes: readonly string[];
}

export interface TokenVerifier {
  /** Throws `UnauthorizedError` for anything it will not vouch for. */
  verify(token: string, options: CallOptions): Promise<VerifiedToken>;
}

export interface RemoteKeyResolverOptions {
  readonly jwksUri: string;
  /** Explicit, because an unbounded key fetch would hang a request. */
  readonly timeoutMs?: number;
  readonly cacheMaxAgeMs?: number;
  readonly cooldownMs?: number;
}

/**
 * The JWKS resolver. Keys are cached for `cacheMaxAgeMs` and an unknown
 * `kid` can only trigger a refetch once per `cooldownMs`, so a stream of
 * forged tokens cannot turn into a stream of outbound requests.
 */
export function createRemoteKeyResolver(
  options: RemoteKeyResolverOptions,
): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(options.jwksUri), {
    timeoutDuration: options.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    cacheMaxAge: options.cacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: options.cooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS,
  });
}

export interface TokenVerifierOptions {
  readonly issuer: string | readonly string[];
  readonly audience: string | readonly string[];
  /** Ignored when `keyResolver` is supplied; required otherwise. */
  readonly jwksUri?: string;
  readonly jwksTimeoutMs?: number;
  readonly jwksCacheMaxAgeMs?: number;
  readonly jwksCooldownMs?: number;
  readonly algorithms?: readonly JWSAlgorithm[];
  readonly clockToleranceSeconds?: number;
  /** Injected by tests, and by any deployment with a pinned key set. */
  readonly keyResolver?: JWTVerifyGetKey;
  /** Expiry is checked against this, so tests never wait. */
  readonly clock?: Clock;
  readonly descriptorClaims?: readonly string[];
  readonly identityIdClaims?: readonly string[];
}

/** Short, non-identifying reasons. These reach the log, not the caller. */
export type TokenRejection =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'bad-signature'
  | 'unknown-key'
  | 'keys-unavailable'
  | 'claims-invalid'
  // Introspection (see introspect.ts): Azure DevOps was asked and said no,
  // or could not be asked at all. The two are different incidents — one is
  // a bad caller, the other is an outage — so they are not merged.
  | 'rejected-by-issuer'
  | 'introspection-unavailable';

const rejectionOf = (error: unknown): TokenRejection => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'bad-signature';
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'unknown-key';
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID':
      return 'keys-unavailable';
    case 'ERR_JWT_INVALID':
    case 'ERR_JWS_INVALID':
      return 'malformed';
    default:
      break;
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const claim =
      typeof error === 'object' && error !== null && 'claim' in error
        ? String((error as { claim?: unknown }).claim)
        : '';
    if (claim === 'iss') return 'wrong-issuer';
    if (claim === 'aud') return 'wrong-audience';
    if (claim === 'nbf') return 'not-yet-valid';
    // A genuinely expired token has its own code; a claim failure on
    // `exp` means it was missing, which is a malformed claim set.
    return 'claims-invalid';
  }
  return 'malformed';
};

/**
 * One 401 for every rejection. `message` and `rejection` carry the
 * reason for the log line; `userMessage` — what the hub renders — says
 * only "please sign in again", and `details` stays empty, so nothing
 * about why the token failed reaches the response body.
 */
export class TokenRejectedError extends UnauthorizedError {
  readonly rejection: TokenRejection;

  constructor(rejection: TokenRejection, options: AppErrorOptions = {}) {
    super(`Access token rejected: ${rejection}`, options);
    this.rejection = rejection;
  }
}

export function isTokenRejected(error: unknown): error is TokenRejectedError {
  return error instanceof TokenRejectedError;
}

const reject = (
  rejection: TokenRejection,
  cause?: unknown,
): TokenRejectedError =>
  new TokenRejectedError(rejection, cause === undefined ? {} : { cause });

const readClaim = (
  claims: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | null => {
  for (const name of names) {
    const parsed = z.string().min(1).safeParse(claims[name]);
    if (parsed.success) return parsed.data;
  }
  return null;
};

const readScopes = (claims: AdoTokenClaims): readonly string[] => {
  const raw = claims.scp;
  if (raw === undefined) return [];
  const values = typeof raw === 'string' ? raw.split(' ') : raw;
  return values.map((value) => value.trim()).filter((value) => value !== '');
};

const asArray = (value: string | readonly string[]): string[] =>
  typeof value === 'string' ? [value] : [...value];

class JoseTokenVerifier implements TokenVerifier {
  private readonly issuers: string[];
  private readonly audiences: string[];
  private readonly algorithms: JWSAlgorithm[];
  private readonly clockToleranceSeconds: number;
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly clock: Clock | null;
  private readonly descriptorClaims: readonly string[];
  private readonly identityIdClaims: readonly string[];

  constructor(options: TokenVerifierOptions) {
    this.issuers = asArray(options.issuer);
    this.audiences = asArray(options.audience);
    this.algorithms = [...(options.algorithms ?? DEFAULT_TOKEN_ALGORITHMS)];
    this.clockToleranceSeconds =
      options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    this.clock = options.clock ?? null;
    this.descriptorClaims =
      options.descriptorClaims ?? DEFAULT_DESCRIPTOR_CLAIMS;
    this.identityIdClaims =
      options.identityIdClaims ?? DEFAULT_IDENTITY_ID_CLAIMS;

    if (options.keyResolver !== undefined) {
      this.keyResolver = options.keyResolver;
    } else if (options.jwksUri !== undefined) {
      this.keyResolver = createRemoteKeyResolver({
        jwksUri: options.jwksUri,
        ...(options.jwksTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.jwksTimeoutMs }),
        ...(options.jwksCacheMaxAgeMs === undefined
          ? {}
          : { cacheMaxAgeMs: options.jwksCacheMaxAgeMs }),
        ...(options.jwksCooldownMs === undefined
          ? {}
          : { cooldownMs: options.jwksCooldownMs }),
      });
    } else {
      throw new TypeError('token verifier needs a jwksUri or a keyResolver');
    }
  }

  async verify(token: string, _options: CallOptions): Promise<VerifiedToken> {
    const candidate = token.trim();
    if (candidate === '') throw reject('missing');

    let payload: unknown;
    try {
      const result = await jwtVerify(candidate, this.keyResolver, {
        issuer: this.issuers,
        audience: this.audiences,
        algorithms: this.algorithms,
        clockTolerance: this.clockToleranceSeconds,
        // A token with no `exp` would otherwise never expire.
        requiredClaims: ['exp'],
        ...(this.clock === null ? {} : { currentDate: this.clock.now() }),
      });
      payload = result.payload;
    } catch (error) {
      throw reject(rejectionOf(error), error);
    }

    const claims = adoTokenClaimsSchema.safeParse(payload);
    const bag = claimBagSchema.safeParse(payload);
    if (!claims.success || !bag.success) throw reject('claims-invalid');

    const descriptor = readClaim(bag.data, this.descriptorClaims);
    const id =
      readClaim(bag.data, this.identityIdClaims) ?? claims.data.sub ?? null;
    if (descriptor === null || id === null) throw reject('claims-invalid');

    const issuedAt = claims.data.iat;
    return {
      descriptor,
      id,
      expiresAt: new Date(claims.data.exp * 1000),
      issuedAt: issuedAt === undefined ? null : new Date(issuedAt * 1000),
      scopes: readScopes(claims.data),
    };
  }
}

export function createTokenVerifier(
  options: TokenVerifierOptions,
): TokenVerifier {
  return new JoseTokenVerifier(options);
}

/**
 * The verified token plus the raw bearer, which the write path replays
 * to Azure DevOps as the caller. It is held for the life of the request
 * and never logged, cached or written to Postgres.
 */
export function toCallerIdentity(
  verified: VerifiedToken,
  accessToken: string,
): CallerIdentity {
  return {
    descriptor: verified.descriptor,
    id: verified.id,
    accessToken,
  };
}

/** Safe log fields for an identity: descriptors and ids, never names. */
export function identityLogFields(
  verified: VerifiedToken,
): Record<string, unknown> {
  return {
    descriptor: verified.descriptor,
    identityId: verified.id,
    tokenExpiresAt: verified.expiresAt.toISOString(),
    scopeCount: verified.scopes.length,
  };
}

const BEARER = /^bearer[ \t]+(.+)$/iu;

/** Pulls the bearer token out of an Authorization header value. */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = BEARER.exec(value.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}
