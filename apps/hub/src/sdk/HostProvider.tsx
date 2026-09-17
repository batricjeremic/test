/**
 * React access to the host. `main.tsx` resolves the handshake, then wraps
 * the tree in `HostProvider`; everything below reads the host from
 * context and never imports the SDK directly.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HubHost, HubHostContext, ThemeVariables } from './types';

const HostReactContext = createContext<HubHost | null>(null);

export type HostProviderProps = {
  host: HubHost;
  children: ReactNode;
};

export function HostProvider({
  host,
  children,
}: HostProviderProps): JSX.Element {
  return (
    <HostReactContext.Provider value={host}>
      {children}
    </HostReactContext.Provider>
  );
}

/** The host. Throws when used outside `HostProvider`, which is a bug. */
export function useHubHost(): HubHost {
  const host = useContext(HostReactContext);
  if (!host) {
    throw new Error('useHubHost must be used inside <HostProvider>');
  }
  return host;
}

/** The host, or null outside `HostProvider`. For optional wiring. */
export function useOptionalHubHost(): HubHost | null {
  return useContext(HostReactContext);
}

/** Organization, project and user context. */
export function useHostContext(): HubHostContext {
  return useHubHost().context;
}

/**
 * The live theme variables, re-read whenever the host re-themes. Most
 * components should use the `--eg-*` CSS tokens instead; this is for the
 * rare case that needs a value in JavaScript.
 */
export function useThemeVariables(): ThemeVariables {
  const host = useHubHost();
  const [variables, setVariables] = useState<ThemeVariables>(() =>
    host.getThemeVariables(),
  );

  useEffect(() => {
    setVariables(host.getThemeVariables());
    return host.onThemeChanged(setVariables);
  }, [host]);

  return variables;
}
