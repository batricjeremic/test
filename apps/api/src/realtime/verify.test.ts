import { describe, expect, it } from 'vitest';
import {
  secretEquals,
  verifyWebhookRequest,
  webhookAuthSchema,
  type WebhookAuth,
} from './verify.js';

const basic: WebhookAuth = {
  kind: 'basic',
  username: 'ado-hooks',
  password: 'a-long-enough-password',
};

const shared: WebhookAuth = {
  kind: 'shared-secret',
  headerName: 'x-eg-hook-secret',
  secret: 'a-secret-of-sufficient-length',
};

const basicHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

describe('webhookAuthSchema', () => {
  it('refuses credentials that are too short to be worth checking', () => {
    expect(
      webhookAuthSchema.safeParse({
        kind: 'shared-secret',
        headerName: 'x',
        secret: 'short',
      }).success,
    ).toBe(false);
    expect(webhookAuthSchema.safeParse(shared).success).toBe(true);
  });
});

describe('secretEquals', () => {
  it('compares values of different lengths without throwing', () => {
    expect(secretEquals('a', 'a-much-longer-value')).toBe(false);
    expect(secretEquals('same', 'same')).toBe(true);
  });
});

describe('verifyWebhookRequest with basic credentials', () => {
  it('accepts the credentials the subscription was created with', () => {
    expect(
      verifyWebhookRequest(basic, {
        authorization: basicHeader(basic.username, 'a-long-enough-password'),
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a wrong password', () => {
    expect(
      verifyWebhookRequest(basic, {
        authorization: basicHeader(basic.username, 'not-the-password'),
      }),
    ).toEqual({ ok: false, reason: 'credentials-mismatch' });
  });

  it('rejects a wrong username', () => {
    expect(
      verifyWebhookRequest(basic, {
        authorization: basicHeader('someone-else', 'a-long-enough-password'),
      }),
    ).toEqual({ ok: false, reason: 'credentials-mismatch' });
  });

  it('rejects a missing header and a bearer token', () => {
    expect(verifyWebhookRequest(basic, {})).toEqual({
      ok: false,
      reason: 'missing-credentials',
    });
    expect(
      verifyWebhookRequest(basic, { authorization: 'Bearer abc' }),
    ).toEqual({ ok: false, reason: 'unsupported-scheme' });
    expect(verifyWebhookRequest(basic, { authorization: 'Basic ' })).toEqual({
      ok: false,
      reason: 'missing-credentials',
    });
  });
});

describe('verifyWebhookRequest with a shared secret', () => {
  it('accepts the configured header, whatever its casing', () => {
    expect(
      verifyWebhookRequest(shared, { 'x-eg-hook-secret': shared.secret }),
    ).toEqual({ ok: true });
  });

  it('rejects a missing or wrong secret', () => {
    expect(verifyWebhookRequest(shared, {})).toEqual({
      ok: false,
      reason: 'missing-credentials',
    });
    expect(
      verifyWebhookRequest(shared, { 'x-eg-hook-secret': 'guess' }),
    ).toEqual({ ok: false, reason: 'credentials-mismatch' });
  });

  it('reads the first value when a header arrives repeated', () => {
    expect(
      verifyWebhookRequest(shared, {
        'x-eg-hook-secret': [shared.secret, 'other'],
      }),
    ).toEqual({ ok: true });
  });
});
