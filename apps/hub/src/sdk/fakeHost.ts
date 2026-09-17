/**
 * A `HubHost` with no Azure DevOps behind it.
 *
 * Every test, story and standalone `vite dev` run uses this. It records
 * what the hub asked for so a test can assert that the token was
 * refreshed rather than pinned.
 */
import type { HubHost, HubHostContext, ThemeVariables } from './types';

/** Azure DevOps light theme, as the host publishes it. */
export const FAKE_LIGHT_THEME: ThemeVariables = {
  'background-color': 'rgba(255, 255, 255, 1)',
  'text-primary-color': 'rgba(0, 0, 0, 0.9)',
  'text-secondary-color': 'rgba(0, 0, 0, 0.55)',
  'communication-background': 'rgba(0, 120, 212, 1)',
  'palette-neutral-0': '255,255,255',
  'palette-neutral-2': '250,249,248',
  'palette-neutral-4': '244,243,242',
  'palette-neutral-8': '234,233,232',
  'palette-neutral-10': '200,198,196',
  'palette-neutral-20': '161,159,157',
  'palette-neutral-30': '121,119,117',
  'palette-neutral-60': '96,94,92',
  'palette-neutral-80': '51,49,47',
  'palette-neutral-100': '0,0,0',
  'palette-primary': '0,120,212',
  'palette-error': '205,74,69',
};

/** Azure DevOps dark theme, as the host publishes it. */
export const FAKE_DARK_THEME: ThemeVariables = {
  ...FAKE_LIGHT_THEME,
  'background-color': 'rgba(31, 31, 31, 1)',
  'text-primary-color': 'rgba(255, 255, 255, 0.9)',
  'text-secondary-color': 'rgba(255, 255, 255, 0.55)',
  'palette-neutral-0': '31,31,31',
  'palette-neutral-2': '37,37,37',
  'palette-neutral-4': '45,45,45',
  'palette-neutral-8': '56,56,56',
  'palette-neutral-10': '66,66,66',
  'palette-neutral-100': '255,255,255',
};

export const FAKE_HOST_CONTEXT: HubHostContext = {
  organizationId: '00000000-0000-0000-0000-0000000000aa',
  organizationName: 'expertgroup',
  organizationUrl: 'https://dev.azure.com/expertgroup',
  projectId: '00000000-0000-0000-0000-0000000000b1',
  projectName: 'Delivery',
  teamId: '00000000-0000-0000-0000-0000000000c1',
  teamName: 'Delivery Team',
  userDescriptor: 'aad.dGVzdC11c2Vy',
  userDisplayName: 'Test User',
  extensionId: 'expertgroup.cross-project-sprint-board',
  contributionId:
    'expertgroup.cross-project-sprint-board.cross-project-sprint-board-hub',
  isHosted: false,
};

export type FakeHubHostOptions = {
  context?: Partial<HubHostContext>;
  /** Token the fake hands out. Rotated by `rotateToken`. */
  token?: string;
  theme?: ThemeVariables;
  /** Organisation-wide settings the fake starts with. */
  settings?: Readonly<Record<string, string>>;
};

export interface FakeHubHost extends HubHost {
  /** How many times the hub asked for a token. */
  readonly tokenRequestCount: number;
  readonly loadSucceededCount: number;
  readonly loadFailures: readonly string[];
  readonly resizeCalls: readonly [number | undefined, number | undefined][];
  /** Changes the token the fake hands out from now on. */
  rotateToken(token: string): void;
  /** Makes the next token request reject once. */
  failNextToken(error: Error): void;
  /** Pushes a new theme to every `onThemeChanged` listener. */
  setTheme(theme: ThemeVariables): void;
  /** The organisation-wide settings as they stand. */
  readonly settings: Readonly<Record<string, string>>;
  /** Makes the next `readSetting` resolve to null, as a refusing host does. */
  failNextSettingRead(): void;
  /** Makes the next `writeSetting` reject once. */
  failNextSettingWrite(error: Error): void;
}

/** Builds a fake host. Safe to call in jsdom and in the browser. */
export function createFakeHubHost(
  options: FakeHubHostOptions = {},
): FakeHubHost {
  const context: HubHostContext = { ...FAKE_HOST_CONTEXT, ...options.context };
  const listeners = new Set<(variables: ThemeVariables) => void>();
  let theme: ThemeVariables = options.theme ?? FAKE_LIGHT_THEME;
  let token = options.token ?? 'fake-access-token';
  let tokenRequestCount = 0;
  let loadSucceededCount = 0;
  let nextTokenError: Error | null = null;
  const loadFailures: string[] = [];
  const resizeCalls: [number | undefined, number | undefined][] = [];
  const settings = new Map<string, string>(
    Object.entries(options.settings ?? {}),
  );
  let refuseNextSettingRead = false;
  let nextSettingWriteError: Error | null = null;

  const issueToken = async (): Promise<string> => {
    tokenRequestCount += 1;
    if (nextTokenError) {
      const error = nextTokenError;
      nextTokenError = null;
      throw error;
    }
    return token;
  };

  return {
    context,
    getAccessToken: issueToken,
    refreshAccessToken: issueToken,
    getThemeVariables: () => theme,
    onThemeChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notifyLoadSucceeded: () => {
      loadSucceededCount += 1;
    },
    notifyLoadFailed: (error) => {
      loadFailures.push(error instanceof Error ? error.message : error);
    },
    resize: (width, height) => {
      resizeCalls.push([width, height]);
    },
    workItemUrl: (projectName, workItemId) =>
      `${context.organizationUrl}/${encodeURIComponent(projectName)}` +
      `/_workitems/edit/${workItemId}`,
    readSetting: async (key) => {
      if (refuseNextSettingRead) {
        refuseNextSettingRead = false;
        return null;
      }
      return settings.get(key) ?? null;
    },
    writeSetting: async (key, value) => {
      if (nextSettingWriteError) {
        const error = nextSettingWriteError;
        nextSettingWriteError = null;
        throw error;
      }
      if (value === null || value === '') settings.delete(key);
      else settings.set(key, value);
    },
    get settings() {
      return Object.fromEntries(settings);
    },
    failNextSettingRead: () => {
      refuseNextSettingRead = true;
    },
    failNextSettingWrite: (error: Error) => {
      nextSettingWriteError = error;
    },
    get tokenRequestCount() {
      return tokenRequestCount;
    },
    get loadSucceededCount() {
      return loadSucceededCount;
    },
    get loadFailures() {
      return loadFailures;
    },
    get resizeCalls() {
      return resizeCalls;
    },
    rotateToken: (next: string) => {
      token = next;
    },
    failNextToken: (error: Error) => {
      nextTokenError = error;
    },
    setTheme: (next: ThemeVariables) => {
      theme = next;
      for (const listener of listeners) listener(next);
    },
  };
}
