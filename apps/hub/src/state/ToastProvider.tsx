/**
 * The toast host's data. The views render the list; this owns it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { MoveFailure } from '@eg/shared';
import { createToastStore, moveFailureToast } from './toasts';
import type { Toast, ToastInput, ToastStore } from './toasts';

const ToastContext = createContext<ToastStore | null>(null);

export type ToastProviderProps = {
  /** Injected in tests to control ids. */
  store?: ToastStore;
  children: ReactNode;
};

export function ToastProvider({
  store,
  children,
}: ToastProviderProps): JSX.Element {
  const value = useMemo(() => store ?? createToastStore(), [store]);
  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

export type UseToastsResult = {
  /** Oldest first. Render them in a live region. */
  toasts: readonly Toast[];
  push(toast: ToastInput): string;
  /** Pushes the spec's wording for a failed move. Returns the toast id. */
  pushMoveFailure(failure: MoveFailure, workItemId: number): string;
  dismiss(id: string): void;
  clear(): void;
};

export function useToasts(): UseToastsResult {
  const store = useContext(ToastContext);
  if (!store) {
    throw new Error('useToasts must be used inside <ToastProvider>');
  }

  const toasts = useSyncExternalStore(
    store.subscribe,
    store.getToasts,
    store.getToasts,
  );

  const pushMoveFailure = useCallback(
    (failure: MoveFailure, workItemId: number) =>
      store.push(moveFailureToast(failure, workItemId)),
    [store],
  );

  return useMemo(
    () => ({
      toasts,
      push: store.push,
      pushMoveFailure,
      dismiss: store.dismiss,
      clear: store.clear,
    }),
    [toasts, store, pushMoveFailure],
  );
}
