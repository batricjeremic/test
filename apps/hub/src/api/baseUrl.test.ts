import { describe, expect, it } from 'vitest';
import { createFakeHubHost } from '../sdk';
import {
  BFF_BASE_URL_SETTING_KEY,
  parseBffBaseUrl,
  resolveBffEndpoint,
  saveBffBaseUrl,
} from './baseUrl';

const BUILD_DEFAULT = 'http://localhost:8080';

describe('parseBffBaseUrl', () => {
  it('accepts an absolute https URL and strips trailing slashes', () => {
    const parsed = parseBffBaseUrl('https://board-api.example.com///');
    expect(parsed).toEqual({ ok: true, url: 'https://board-api.example.com' });
  });

  it('accepts http, because a developer tunnels to one', () => {
    expect(parseBffBaseUrl('http://localhost:8080')).toEqual({
      ok: true,
      url: 'http://localhost:8080',
    });
  });

  it('rejects a relative path with a reason the admin can act on', () => {
    const parsed = parseBffBaseUrl('/api');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/absolute URL/i);
  });

  it('rejects a non-HTTP scheme', () => {
    const parsed = parseBffBaseUrl('ftp://board-api.example.com');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/http/i);
  });
});

describe('resolveBffEndpoint', () => {
  it('uses the organisation setting when one is stored', async () => {
    const host = createFakeHubHost({
      settings: { [BFF_BASE_URL_SETTING_KEY]: 'https://staging.example.com' },
    });

    await expect(resolveBffEndpoint(host)).resolves.toEqual({
      url: 'https://staging.example.com',
      source: 'organization-setting',
    });
  });

  it('falls back to the build default when nothing is stored', async () => {
    const host = createFakeHubHost();

    await expect(resolveBffEndpoint(host)).resolves.toEqual({
      url: BUILD_DEFAULT,
      source: 'build-default',
    });
  });

  // A malformed stored value must not take the hub down: it is treated as
  // unset, exactly as an unreadable one is.
  it('falls back when the stored value is malformed', async () => {
    const host = createFakeHubHost({
      settings: { [BFF_BASE_URL_SETTING_KEY]: 'not a url' },
    });

    await expect(resolveBffEndpoint(host)).resolves.toEqual({
      url: BUILD_DEFAULT,
      source: 'build-default',
    });
  });

  it('falls back when the host refuses to answer', async () => {
    const host = createFakeHubHost({
      settings: { [BFF_BASE_URL_SETTING_KEY]: 'https://staging.example.com' },
    });
    host.failNextSettingRead();

    await expect(resolveBffEndpoint(host)).resolves.toEqual({
      url: BUILD_DEFAULT,
      source: 'build-default',
    });
  });
});

describe('saveBffBaseUrl', () => {
  it('stores a normalised URL organisation-wide', async () => {
    const host = createFakeHubHost();

    await saveBffBaseUrl(host, '  https://board-api.example.com/  ');

    expect(host.settings[BFF_BASE_URL_SETTING_KEY]).toBe(
      'https://board-api.example.com',
    );
  });

  it('clears the setting when given an empty value', async () => {
    const host = createFakeHubHost({
      settings: { [BFF_BASE_URL_SETTING_KEY]: 'https://staging.example.com' },
    });

    await saveBffBaseUrl(host, '   ');

    expect(host.settings[BFF_BASE_URL_SETTING_KEY]).toBeUndefined();
    await expect(resolveBffEndpoint(host)).resolves.toMatchObject({
      source: 'build-default',
    });
  });

  it('refuses to store an invalid URL rather than writing rubbish', async () => {
    const host = createFakeHubHost();

    await expect(saveBffBaseUrl(host, 'nope')).rejects.toThrow(/absolute URL/i);
    expect(host.settings[BFF_BASE_URL_SETTING_KEY]).toBeUndefined();
  });

  it('propagates a write failure instead of reporting success', async () => {
    const host = createFakeHubHost();
    host.failNextSettingWrite(new Error('the host rejected the write'));

    await expect(
      saveBffBaseUrl(host, 'https://board-api.example.com'),
    ).rejects.toThrow(/rejected the write/);
  });
});
