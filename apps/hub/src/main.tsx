/**
 * Hub entry point.
 *
 * Nothing renders until the Azure DevOps handshake resolves, and if it
 * never does the frame shows a readable failure rather than staying
 * blank. Both manifest contributions load this same bundle; which view
 * mounts is decided by the contribution id.
 */
import { Component, StrictMode, Suspense, lazy, useMemo } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiProvider } from './api';
import { HostProvider, initHubHost } from './sdk';
import type { HubHost } from './sdk';
import { ToastProvider } from './state';
import type { HubViewId } from './types';
import { VIEW_FILE, resolveViewId } from './viewRouting';
import './theme.css';

/**
 * The board and admin views are built alongside this file. Each one
 * default-exports its root component from a module named `BoardView.tsx`
 * or `AdminView.tsx` anywhere under `src/`. The glob resolves to nothing
 * until they exist, and the hub then renders a readable placeholder
 * instead of failing to build.
 */
const viewModules = import.meta.glob('./**/*View.tsx');

function findViewLoader(
  viewId: HubViewId,
): (() => Promise<unknown>) | undefined {
  const suffix = VIEW_FILE[viewId];
  const key = Object.keys(viewModules).find((path) => path.endsWith(suffix));
  return key === undefined ? undefined : viewModules[key];
}

function ViewHost({ viewId }: { viewId: HubViewId }): JSX.Element {
  const View = useMemo(() => {
    const loader = findViewLoader(viewId);
    if (!loader) return null;
    return lazy(async () => {
      const module = await loader();
      const component = (module as { default?: unknown }).default;
      if (typeof component !== 'function') {
        throw new Error(
          `${VIEW_FILE[viewId]} must default-export a React component`,
        );
      }
      return { default: component as ComponentType };
    });
  }, [viewId]);

  if (!View) {
    return (
      <div className="eg-hub">
        <section className="eg-panel eg-fatal">
          <h1>The {viewId} view is not built yet</h1>
          <p>
            This bundle expects a module ending in{' '}
            <code>{VIEW_FILE[viewId]}</code> under <code>src/</code>, default
            exporting a React component. Everything else — the host handshake,
            the BFF client, the board store and the realtime channel — is wired
            and waiting for it.
          </p>
        </section>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="eg-hub">Loading the board…</div>}>
      <View />
    </Suspense>
  );
}

type ErrorBoundaryProps = { host: HubHost | null; children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/**
 * React has no hook equivalent of `componentDidCatch`, so this is the one
 * class component in the hub. Without it a render failure leaves an empty
 * Azure DevOps frame with no explanation.
 */
class HubErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public override state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.host?.notifyLoadFailed(error);
  }

  public override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <FatalError
        title="The board could not be rendered"
        detail={error.message}
      />
    );
  }
}

function FatalError({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): JSX.Element {
  return (
    <div className="eg-hub">
      <section className="eg-panel eg-fatal" role="alert">
        <h1>{title}</h1>
        <p>
          Reload the hub. If it keeps happening, send this to the delivery team
          along with the time you saw it.
        </p>
        <p className="eg-fatal__detail">{detail}</p>
      </section>
    </div>
  );
}

function HubRoot({ host }: { host: HubHost }): JSX.Element {
  const viewId = resolveViewId(host.context.contributionId);
  return (
    <HostProvider host={host}>
      <ApiProvider>
        <ToastProvider>
          <HubErrorBoundary host={host}>
            <ViewHost viewId={viewId} />
          </HubErrorBoundary>
        </ToastProvider>
      </ApiProvider>
    </HostProvider>
  );
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) return;
  const root = createRoot(container);

  let host: HubHost;
  try {
    host = await initHubHost();
  } catch (error) {
    root.render(
      <StrictMode>
        <FatalError
          title="Azure DevOps did not finish loading this hub"
          detail={error instanceof Error ? error.message : String(error)}
        />
      </StrictMode>,
    );
    return;
  }

  root.render(
    <StrictMode>
      <HubRoot host={host} />
    </StrictMode>,
  );
  // The manifest declares `loaded: false`, so the host keeps its spinner
  // until we say the frame has something in it.
  host.notifyLoadSucceeded();
}

void bootstrap();
