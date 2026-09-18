/**
 * The host boundary.
 *
 * Everything the hub needs from Azure DevOps arrives through `HubHost`.
 * The real implementation talks to `azure-devops-extension-sdk`; the fake
 * one in `fakeHost.ts` implements the same interface so no test needs an
 * Azure DevOps frame.
 */

/** Organization, project and user context, read once after the handshake. */
export type HubHostContext = {
  /** Organization (host) id. */
  readonly organizationId: string;
  /** Organization name, e.g. `expertgroup`. */
  readonly organizationName: string;
  /** `https://dev.azure.com/<organization>`, no trailing slash. */
  readonly organizationUrl: string;
  /** Project the hub was opened in. Null on an organization-level page. */
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** Team the page targets, when there is one. */
  readonly teamId: string | null;
  readonly teamName: string | null;
  /** `System.AssignedTo`-compatible descriptor for the signed-in user. */
  readonly userDescriptor: string;
  /** Personal data: render it, never log it. */
  readonly userDisplayName: string;
  /** `<publisher>.<extension>`. */
  readonly extensionId: string;
  /** The contribution that caused this frame to load. */
  readonly contributionId: string;
  /** True inside a real Azure DevOps frame, false for the fake host. */
  readonly isHosted: boolean;
};

/** The ADO theme, as the raw custom-property names the host publishes. */
export type ThemeVariables = Readonly<Record<string, string>>;

/**
 * The host as the rest of the hub sees it.
 *
 * `getAccessToken` returns a short-lived user token. It is refreshed
 * behind a small TTL rather than cached for the session, and it must
 * never be logged, never be put in a URL and never be stored.
 */
export interface HubHost {
  readonly context: HubHostContext;
  /** A currently-valid user token. Cheap to call on every request. */
  getAccessToken(): Promise<string>;
  /** Drops the cached token and fetches a new one (401 recovery). */
  refreshAccessToken(): Promise<string>;
  /** Theme custom properties currently applied to `:root`. */
  getThemeVariables(): ThemeVariables;
  /** Fires whenever the host re-themes the frame. Returns an unsubscribe. */
  onThemeChanged(listener: (variables: ThemeVariables) => void): () => void;
  /** Tells the host the hub rendered; stops its loading indicator. */
  notifyLoadSucceeded(): void;
  /** Tells the host the hub failed to render. */
  notifyLoadFailed(error: Error | string): void;
  /** Asks the host frame to resize to the current content height. */
  resize(width?: number, height?: number): void;
  /** Deep link to a work item's native form, for toasts and card detail. */
  workItemUrl(projectName: string, workItemId: number): string;
  /**
   * Opens the work item in Azure DevOps' OWN form, over our frame.
   *
   * We used to render that form in an iframe. Azure DevOps refuses to be
   * framed — `dev.azure.com refused to connect` — so the dialog was
   * always going to be empty. The host service is the supported way, and
   * it gives the real form with save, history and attachments rather
   * than a reconstruction of it.
   *
   * Resolves false when the host does not offer the service, so the
   * caller can fall back to a plain link instead of doing nothing.
   */
  openWorkItem(workItemId: number, openInNewTab?: boolean): Promise<boolean>;
  /**
   * Reads an organisation-wide extension setting, or null when unset.
   *
   * Organisation-wide, not per-user: one administrator sets it and every
   * user of that organisation sees the same value. This is what lets one
   * `.vsix` serve every environment instead of baking configuration into
   * the bundle at build time.
   *
   * Returns null rather than throwing when the value is absent or the
   * host refuses — a hub that cannot read its settings must still render.
   */
  readSetting(key: string): Promise<string | null>;
  /** Writes an organisation-wide setting. `null` removes it. */
  writeSetting(key: string, value: string | null): Promise<void>;
}

/** Options for `initHubHost`. */
export type InitHubHostOptions = {
  /**
   * Seconds a fetched token is reused before it is fetched again.
   * Deliberately short: the token is short-lived and must not be pinned
   * for the life of the page. Default 240.
   */
  readonly tokenTtlSeconds?: number;
  /** Milliseconds to wait for the host handshake. Default 15000. */
  readonly handshakeTimeoutMs?: number;
};
