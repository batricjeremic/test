/**
 * React access to the BFF client.
 *
 * `main.tsx` builds a client from the host and provides it here; tests
 * and the other views provide `createFakeBoardApiClient()` instead. No
 * component ever constructs a client of its own.
 */
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useHubHost } from '../sdk';
import { createBoardApiClient, resolveBffBaseUrl } from './client';
import type { BoardApiClient } from './client';

const ApiContext = createContext<BoardApiClient | null>(null);

export type ApiProviderProps = {
  /** Injected client. Omit to build one from the host in context. */
  client?: BoardApiClient;
  /** Overrides the built-in `VITE_BFF_BASE_URL`. */
  baseUrl?: string;
  children: ReactNode;
};

export function ApiProvider({
  client,
  baseUrl,
  children,
}: ApiProviderProps): JSX.Element {
  return client ? (
    <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
  ) : (
    <HostBackedApiProvider baseUrl={baseUrl}>{children}</HostBackedApiProvider>
  );
}

function HostBackedApiProvider({
  baseUrl,
  children,
}: {
  baseUrl: string | undefined;
  children: ReactNode;
}): JSX.Element {
  const host = useHubHost();
  const client = useMemo(
    () =>
      createBoardApiClient({
        baseUrl: baseUrl ?? resolveBffBaseUrl(),
        getAccessToken: () => host.getAccessToken(),
      }),
    [host, baseUrl],
  );
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** The BFF client. Throws outside `ApiProvider`, which is a bug. */
export function useApiClient(): BoardApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error('useApiClient must be used inside <ApiProvider>');
  }
  return client;
}
