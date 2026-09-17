/**
 * Where the BFF lives.
 *
 * Resolved at runtime from an organisation-wide extension setting, so one
 * `.vsix` serves every environment. `VITE_BFF_BASE_URL` remains as the
 * build-time fallback for local development and for the first load of a
 * fresh installation, before an administrator has set the endpoint.
 *
 * The stored value arrives from outside the bundle, so it is validated
 * rather than trusted — an unparseable or non-HTTP value is treated as
 * unset, which falls back rather than breaking the hub.
 */
import { z } from 'zod';
import type { HubHost } from '../sdk';
import { resolveBffBaseUrl } from './client';

/** Key under which the endpoint is stored, organisation-wide. */
export const BFF_BASE_URL_SETTING_KEY = 'bffBaseUrl';

/** Where the endpoint in use came from. Surfaced in the admin screen. */
export type BffEndpointSource = 'organization-setting' | 'build-default';

export type BffEndpoint = {
  readonly url: string;
  readonly source: BffEndpointSource;
};

/**
 * Absolute `http:` or `https:` only.
 *
 * `http:` is allowed because a developer tunnels to one; in a real
 * installation the hub is served over HTTPS and the browser blocks the
 * mixed-content call anyway, which is a clearer failure than us guessing.
 */
const bffBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an absolute URL, e.g. https://board-api.example.com',
      });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must use http or https',
      });
    }
  })
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * Validates a candidate endpoint.
 *
 * Returns the normalised URL, or the reason it was rejected — the admin
 * screen shows that reason rather than silently discarding the input.
 */
export function parseBffBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const result = bffBaseUrlSchema.safeParse(raw);
  if (result.success) return { ok: true, url: result.data };
  return {
    ok: false,
    reason: result.error.issues[0]?.message ?? 'is not a valid URL',
  };
}

/**
 * The endpoint this session should use.
 *
 * The organisation setting wins when it is present and valid. Anything
 * else — unset, unreadable, or stored malformed — falls back to the
 * build-time default, because a hub that cannot read a setting must still
 * render against something.
 */
export async function resolveBffEndpoint(host: HubHost): Promise<BffEndpoint> {
  const stored = await host.readSetting(BFF_BASE_URL_SETTING_KEY);
  if (stored !== null) {
    const parsed = parseBffBaseUrl(stored);
    if (parsed.ok) return { url: parsed.url, source: 'organization-setting' };
  }
  return { url: resolveBffBaseUrl(), source: 'build-default' };
}

/** Stores the endpoint for the whole organisation. Empty clears it. */
export async function saveBffBaseUrl(
  host: HubHost,
  raw: string,
): Promise<void> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    await host.writeSetting(BFF_BASE_URL_SETTING_KEY, null);
    return;
  }
  const parsed = parseBffBaseUrl(trimmed);
  if (!parsed.ok) {
    throw new Error(`The endpoint ${parsed.reason}`);
  }
  await host.writeSetting(BFF_BASE_URL_SETTING_KEY, parsed.url);
}
