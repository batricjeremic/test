/**
 * Toasts, and the exact wording the spec's write-failure table asks for.
 *
 * `describeMoveFailure` is a pure function so the board view, the toast
 * host and the tests all render the same sentence for the same reason.
 */
import type { MoveFailure, MoveFailureReason } from '@eg/shared';

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

/** Optional button on a toast, e.g. "Open work item" on a rule violation. */
export type ToastAction = {
  label: string;
  /** Opens the native work item form. */
  href?: string;
  onAction?: () => void;
};

export type ToastContent = {
  severity: ToastSeverity;
  title: string;
  message: string;
  action?: ToastAction;
};

export type ToastInput = ToastContent & {
  /** Set for a move failure, so a view can style by reason. */
  reason?: MoveFailureReason;
  workItemId?: number;
  /** Null keeps the toast until it is dismissed. Default 8000. */
  timeoutMs?: number | null;
};

export type Toast = ToastInput & {
  readonly id: string;
  readonly createdAt: number;
};

export const DEFAULT_TOAST_TIMEOUT_MS = 8_000;

export interface ToastStore {
  getToasts(): readonly Toast[];
  subscribe(listener: () => void): () => void;
  /** Adds a toast and returns its id. */
  push(toast: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

export function createToastStore(
  newId: () => string = defaultToastId,
): ToastStore {
  const listeners = new Set<() => void>();
  let toasts: readonly Toast[] = [];

  const publish = (next: readonly Toast[]): void => {
    toasts = next;
    for (const listener of listeners) listener();
  };

  return {
    getToasts: () => toasts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push: (toast) => {
      const id = newId();
      const timeoutMs =
        toast.timeoutMs === undefined
          ? DEFAULT_TOAST_TIMEOUT_MS
          : toast.timeoutMs;
      publish([...toasts, { ...toast, timeoutMs, id, createdAt: Date.now() }]);
      return id;
    },
    dismiss: (id) => {
      publish(toasts.filter((toast) => toast.id !== id));
    },
    clear: () => {
      publish([]);
    },
  };
}

function defaultToastId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `toast-${Date.now().toString(16)}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

/**
 * The spec's failure table, row for row. The BFF's own `message` is
 * preferred when it sent one, because it can name the person, the field
 * or the states; the fallbacks below keep the toast useful when it did
 * not.
 */
export function describeMoveFailure(failure: MoveFailure): ToastContent {
  switch (failure.reason) {
    case 'revision-conflict':
      return {
        severity: 'warning',
        title: 'That card changed while you were looking at it',
        message:
          failure.message ||
          `${failure.changedBy?.displayName ?? 'Someone'} moved this to ` +
            `${failure.currentColumnName} a moment ago. The board has been ` +
            'refreshed.',
      };

    case 'rule-violation':
      return {
        severity: 'error',
        title: `${failure.fieldDisplayName || failure.field} is required`,
        message:
          failure.message ||
          `${failure.fieldDisplayName || failure.field} must be filled in ` +
            `before this work item can move to ` +
            `${failure.targetState ?? 'that state'}.`,
        action: { label: 'Open work item', href: failure.workItemUrl },
      };

    case 'transition-not-allowed':
      return {
        severity: 'error',
        title: 'That state change is not allowed',
        message:
          failure.message ||
          `The process does not allow ${failure.fromState} to ` +
            `${failure.toState}. Allowed from here: ` +
            `${formatList(failure.allowedStates)}.`,
      };

    case 'permission-denied':
      return {
        severity: 'error',
        title: 'You cannot change work items in that project',
        message:
          failure.message ||
          `You do not have write access to ` +
            `${failure.projectName || failure.projectId}.`,
      };

    case 'mapping-missing':
      return {
        severity: 'warning',
        title: 'That column is not mapped for this team',
        message:
          failure.message ||
          `${failure.teamName || failure.teamId} has no column mapped to ` +
            `${failure.canonicalColumnName || failure.canonicalColumnId}. ` +
            'An admin can add the mapping on the board settings screen.',
      };

    case 'service-unavailable':
      return {
        severity: 'error',
        title: 'Azure DevOps is busy',
        message:
          failure.message ||
          `The move was tried ${failure.attempts} times and did not go ` +
            'through. The card has been put back.' +
            (failure.retryAfterSeconds === null
              ? ''
              : ` Try again in ${failure.retryAfterSeconds}s.`),
      };

    default:
      return {
        severity: 'error',
        title: 'The card could not be moved',
        message: 'The card has been put back where it was.',
      };
  }
}

/** Builds the toast for a failed move, including its work item id. */
export function moveFailureToast(
  failure: MoveFailure,
  workItemId: number,
): ToastInput {
  return {
    ...describeMoveFailure(failure),
    reason: failure.reason,
    workItemId,
    timeoutMs: failure.reason === 'rule-violation' ? null : undefined,
  };
}

function formatList(values: readonly string[]): string {
  if (values.length === 0) return 'nothing';
  if (values.length === 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}
