/**
 * Proving a webhook delivery really came from our subscription.
 *
 * Spec, "Realtime": one service hook subscription per project pointing at
 * a webhook endpoint. Azure DevOps authenticates that delivery with the
 * consumer inputs the subscription was created with — HTTP basic
 * credentials, or a custom header carrying a shared secret. The body is
 * never proof of anything: anyone can POST a plausible
 * `workitem.updated` document at a public endpoint, and acting on it
 * would invalidate caches and push deltas on demand.
 *
 * Comparisons are constant time over SHA-256 digests, so neither the
 * value nor its length leaks through timing. Nothing here is ever
 * logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** How the subscription was configured to authenticate itself. */
export const webhookAuthSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('basic'),
    username: z.string().min(1),
    password: z.string().min(12),
  }),
  z.object({
    kind: z.literal('shared-secret'),
    headerName: z.string().min(1),
    secret: z.string().min(16),
  }),
]);
export type WebhookAuth = z.infer<typeof webhookAuthSchema>;

/** Raw inbound headers, as Node and Fastify hand them over. */
export type WebhookHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WebhookRejection };

/** Why a delivery was refused. Safe to log; carries no secret. */
export type WebhookRejection =
  'missing-credentials' | 'unsupported-scheme' | 'credentials-mismatch';

const firstHeader = (headers: WebhookHeaders, name: string): string | null => {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return null;
  const single = Array.isArray(value) ? value[0] : value;
  if (single === undefined || single.length === 0) return null;
  return single;
};

/** Constant-time equality that does not leak the length either. */
export function secretEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Checks one delivery against the configured credentials. Returns a
 * reason rather than throwing, so the route can answer 401 without a
 * stack and log the reason with the trace id.
 */
export function verifyWebhookRequest(
  auth: WebhookAuth,
  headers: WebhookHeaders,
): WebhookVerification {
  if (auth.kind === 'shared-secret') {
    const presented = firstHeader(headers, auth.headerName);
    if (presented === null) return { ok: false, reason: 'missing-credentials' };
    return secretEquals(presented, auth.secret)
      ? { ok: true }
      : { ok: false, reason: 'credentials-mismatch' };
  }

  const header = firstHeader(headers, 'authorization');
  if (header === null) return { ok: false, reason: 'missing-credentials' };
  const [scheme, ...rest] = header.split(' ');
  if (scheme === undefined || scheme.toLowerCase() !== 'basic') {
    return { ok: false, reason: 'unsupported-scheme' };
  }
  const encoded = rest.join(' ').trim();
  if (encoded.length === 0) return { ok: false, reason: 'missing-credentials' };

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'credentials-mismatch' };
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return { ok: false, reason: 'credentials-mismatch' };
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // Both halves are always compared, so a wrong username and a wrong
  // password take the same time.
  const userMatches = secretEquals(username, auth.username);
  const passwordMatches = secretEquals(password, auth.password);
  return userMatches && passwordMatches
    ? { ok: true }
    : { ok: false, reason: 'credentials-mismatch' };
}
