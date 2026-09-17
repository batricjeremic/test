/**
 * The real host: `azure-devops-extension-sdk` behind the `HubHost`
 * interface.
 *
 * The SDK module is imported lazily so that importing anything from
 * `src/sdk` in a test does not start an XDM handshake with a parent frame
 * that is not there.
 */
import type {
  HubHost,
  HubHostContext,
  InitHubHostOptions,
  ThemeVariables,
} from './types';
import { observeHostTheme, readThemeVariables } from './theme';

const DEFAULT_TOKEN_TTL_SECONDS = 240;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

import type * as AdoSdkModule from 'azure-devops-extension-sdk';

type AdoSdk = typeof AdoSdkModule;

/** Thrown when the host handshake never completes. */
export class HostHandshakeError extends Error {
  public override readonly name = 'HostHandshakeError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Runs the `init` / `ready` handshake, reads the organization, project
 * and user context, and returns a host whose token accessor refreshes.
 *
 * `notifyLoadSucceeded` is deliberately NOT called here: the manifest
 * declares `loaded: false`, and `main.tsx` notifies the host only once
 * React has painted something.
 */
export async function initHubHost(
  options: InitHubHostOptions = {},
): Promise<HubHost> {
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const sdk: AdoSdk = await import('azure-devops-extension-sdk');

  await withTimeout(
    sdk.init({ loaded: false, applyTheme: true }),
    timeoutMs,
    'SDK.init did not complete',
  );
  await withTimeout(sdk.ready(), timeoutMs, 'SDK.ready did not complete');

  return createHubHost(sdk, options);
}

/** Builds the host from an already-initialised SDK module. */
export function createHubHost(
  sdk: AdoSdk,
  options: InitHubHostOptions = {},
): HubHost {
  const context = readHostContext(sdk);
  const ttlMs = (options.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;
  const tokens = createTokenAccessor(() => sdk.getAccessToken(), ttlMs);

  return {
    context,
    getAccessToken: tokens.get,
    refreshAccessToken: tokens.refresh,
    getThemeVariables: () => readThemeVariables(),
    onThemeChanged: (listener: (variables: ThemeVariables) => void) =>
      observeHostTheme(listener),
    notifyLoadSucceeded: () => {
      void sdk.notifyLoadSucceeded();
    },
    notifyLoadFailed: (error: Error | string) => {
      void sdk.notifyLoadFailed(error);
    },
    resize: (width?: number, height?: number) => {
      sdk.resize(width, height);
    },
    workItemUrl: (projectName: string, workItemId: number) =>
      buildWorkItemUrl(context.organizationUrl, projectName, workItemId),
  };
}

/**
 * Short-lived token, refreshed rather than pinned for the session.
 *
 * Concurrent callers share one in-flight fetch, so a board load that
 * fires eight requests at once does not ask the host eight times. The
 * token value is never logged and never leaves the Authorization header.
 */
export function createTokenAccessor(
  fetchToken: () => Promise<string>,
  ttlMs: number,
  now: () => number = () => Date.now(),
): { get: () => Promise<string>; refresh: () => Promise<string> } {
  let cached: { value: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const load = async (): Promise<string> => {
    const value = await fetchToken();
    if (typeof value !== 'string' || value.length === 0) {
      throw new HostHandshakeError('The host returned an empty access token');
    }
    cached = { value, expiresAt: now() + ttlMs };
    return value;
  };

  const start = (): Promise<string> => {
    if (inFlight) return inFlight;
    const pending = load().finally(() => {
      inFlight = null;
    });
    inFlight = pending;
    return pending;
  };

  return {
    get: async () => {
      const current = cached;
      if (current && current.expiresAt > now()) return current.value;
      return start();
    },
    refresh: async () => {
      cached = null;
      return start();
    },
  };
}

/** `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>`. */
export function buildWorkItemUrl(
  organizationUrl: string,
  projectName: string,
  workItemId: number,
): string {
  const org = organizationUrl.replace(/\/+$/, '');
  return `${org}/${encodeURIComponent(projectName)}/_workitems/edit/${workItemId}`;
}

function readHostContext(sdk: AdoSdk): HubHostContext {
  const host = sdk.getHost();
  const user = sdk.getUser();
  const extension = sdk.getExtensionContext();
  const web = safely(() => sdk.getWebContext());
  const project = web?.project ?? null;
  const team = web?.team ?? null;

  return {
    organizationId: host.id,
    organizationName: host.name,
    organizationUrl: host.isHosted
      ? `https://dev.azure.com/${host.name}`
      : window.location.origin,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    userDescriptor: user.descriptor,
    userDisplayName: user.displayName,
    extensionId: extension.id,
    contributionId: safely(() => sdk.getContributionId()) ?? extension.id,
    isHosted: host.isHosted,
  };
}

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HostHandshakeError(`${message} within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
