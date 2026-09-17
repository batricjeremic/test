import { describe, expect, it, vi } from 'vitest';
import { buildWorkItemUrl, createTokenAccessor } from './adoHost';
import { createFakeHubHost, FAKE_DARK_THEME } from './fakeHost';
import { isDarkTheme } from './theme';

describe('createTokenAccessor', () => {
  it('reuses a token inside its TTL and fetches a new one after it', async () => {
    let now = 0;
    const fetchToken = vi.fn(async () => `token-${now}`);
    const tokens = createTokenAccessor(fetchToken, 1_000, () => now);

    expect(await tokens.get()).toBe('token-0');
    expect(await tokens.get()).toBe('token-0');
    expect(fetchToken).toHaveBeenCalledTimes(1);

    now = 1_001;
    expect(await tokens.get()).toBe('token-1001');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const fetchToken = vi.fn(async () => 'token-abc');
    const tokens = createTokenAccessor(fetchToken, 60_000);

    const [first, second, third] = await Promise.all([
      tokens.get(),
      tokens.get(),
      tokens.get(),
    ]);

    expect([first, second, third]).toEqual([
      'token-abc',
      'token-abc',
      'token-abc',
    ]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('drops the cached token on refresh', async () => {
    let issued = 0;
    const tokens = createTokenAccessor(
      async () => `token-${(issued += 1)}`,
      60_000,
    );

    expect(await tokens.get()).toBe('token-1');
    expect(await tokens.refresh()).toBe('token-2');
    expect(await tokens.get()).toBe('token-2');
  });

  it('refuses an empty token rather than sending an empty header', async () => {
    const tokens = createTokenAccessor(async () => '', 60_000);
    await expect(tokens.get()).rejects.toThrow(/empty access token/i);
  });
});

describe('buildWorkItemUrl', () => {
  it('builds a deep link to the native work item form', () => {
    expect(
      buildWorkItemUrl('https://dev.azure.com/expertgroup/', 'Data and AI', 42),
    ).toBe(
      'https://dev.azure.com/expertgroup/Data%20and%20AI/_workitems/edit/42',
    );
  });
});

describe('fake host', () => {
  it('implements the same interface without an Azure DevOps frame', async () => {
    const host = createFakeHubHost();

    expect(await host.getAccessToken()).toBe('fake-access-token');
    expect(host.tokenRequestCount).toBe(1);

    host.rotateToken('token-2');
    expect(await host.refreshAccessToken()).toBe('token-2');

    host.notifyLoadSucceeded();
    expect(host.loadSucceededCount).toBe(1);

    host.notifyLoadFailed(new Error('nope'));
    expect(host.loadFailures).toEqual(['nope']);
  });

  it('pushes theme changes to listeners and unsubscribes cleanly', () => {
    const host = createFakeHubHost();
    const seen: string[] = [];
    const unsubscribe = host.onThemeChanged((variables) => {
      seen.push(variables['background-color'] ?? '');
    });

    host.setTheme(FAKE_DARK_THEME);
    expect(seen).toHaveLength(1);
    expect(isDarkTheme(host.getThemeVariables())).toBe(true);

    unsubscribe();
    host.setTheme(FAKE_DARK_THEME);
    expect(seen).toHaveLength(1);
  });
});
