/**
 * Where this organisation's hub sends its requests.
 *
 * Stored organisation-wide rather than compiled into the bundle, so one
 * packaged extension serves development, staging and production and the
 * artifact promoted between them is byte-identical.
 *
 * Changing it takes effect on the next load of the hub, not immediately:
 * the client for this session was built when the frame opened.
 */
import { useEffect, useState } from 'react';
import { parseBffBaseUrl, resolveBffEndpoint, saveBffBaseUrl } from '../api';
import type { BffEndpoint } from '../api';
import { useHubHost } from '../sdk';

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

export type BffEndpointPanelProps = {
  /** Skips the initial read. Tests pass the endpoint directly. */
  readonly initialEndpoint?: BffEndpoint;
};

export function BffEndpointPanel({
  initialEndpoint,
}: BffEndpointPanelProps): JSX.Element {
  const host = useHubHost();
  const [endpoint, setEndpoint] = useState<BffEndpoint | null>(
    initialEndpoint ?? null,
  );
  const [draft, setDraft] = useState(initialEndpoint?.url ?? '');
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    if (initialEndpoint) return;
    let cancelled = false;
    void resolveBffEndpoint(host).then((resolved) => {
      if (cancelled) return;
      setEndpoint(resolved);
      setDraft(resolved.url);
    });
    return () => {
      cancelled = true;
    };
  }, [host, initialEndpoint]);

  const validation = draft.trim() === '' ? null : parseBffBaseUrl(draft);
  const invalid = validation !== null && !validation.ok;

  const onSave = async (): Promise<void> => {
    setSave({ kind: 'saving' });
    try {
      await saveBffBaseUrl(host, draft);
      const resolved = await resolveBffEndpoint(host);
      setEndpoint(resolved);
      setSave({ kind: 'saved' });
    } catch (error) {
      setSave({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-endpoint-heading"
      data-source={endpoint?.source ?? 'loading'}
    >
      <h2 id="eg-admin-endpoint-heading">Board API endpoint</h2>

      <p className="eg-admin__hint">
        Where this organisation&rsquo;s hub sends its requests. Set here rather
        than compiled into the extension, so the same packaged extension works
        in every environment.
      </p>

      {endpoint?.source === 'build-default' && (
        <p className="eg-admin__status" data-testid="endpoint-source">
          No endpoint is set for this organisation. The hub is falling back to
          the value compiled into this build, <code>{endpoint.url}</code>. Set
          one below.
        </p>
      )}
      {endpoint?.source === 'organization-setting' && (
        <p className="eg-admin__status" data-testid="endpoint-source">
          Set for this organisation.
        </p>
      )}

      <label className="eg-admin__field">
        <span>Endpoint URL</span>
        <input
          type="url"
          inputMode="url"
          value={draft}
          placeholder="https://board-api.example.com"
          aria-invalid={invalid}
          aria-describedby={invalid ? 'eg-admin-endpoint-error' : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSave({ kind: 'idle' });
          }}
        />
      </label>

      {invalid && validation !== null && !validation.ok && (
        <p
          className="eg-admin__issues"
          id="eg-admin-endpoint-error"
          role="alert"
        >
          The endpoint {validation.reason}.
        </p>
      )}

      <div className="eg-admin__savebar">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={invalid || save.kind === 'saving'}
        >
          {save.kind === 'saving' ? 'Saving…' : 'Save endpoint'}
        </button>
        {save.kind === 'saved' && (
          <span className="eg-admin__status" role="status">
            Saved. It takes effect the next time the hub is opened.
          </span>
        )}
        {save.kind === 'error' && (
          <span className="eg-admin__issues" role="alert">
            {save.message}
          </span>
        )}
      </div>

      <p className="eg-admin__hint">
        Clearing this field removes the setting, and the hub falls back to the
        value compiled into the build.
      </p>
    </section>
  );
}

export default BffEndpointPanel;
