/**
 * The toast host.
 *
 * Every rolled-back move says why, in a live region, because a move that
 * silently went back is the failure this product cannot afford. Rule
 * violations are sticky and carry the button that opens the work item
 * form; everything else times itself out.
 */
import { useEffect } from 'react';
import { useToasts } from '../state';

export function BoardToasts(): JSX.Element {
  const { toasts, dismiss } = useToasts();

  useEffect(() => {
    const timers = toasts
      .filter(
        (toast) => typeof toast.timeoutMs === 'number' && toast.timeoutMs > 0,
      )
      .map((toast) =>
        window.setTimeout(() => dismiss(toast.id), toast.timeoutMs ?? 0),
      );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  return (
    <div className="eg-toasts" aria-live="assertive" aria-atomic="false">
      {toasts.map((toast) => (
        <div
          className="eg-toast"
          key={toast.id}
          role="alert"
          data-severity={toast.severity}
          data-reason={toast.reason ?? ''}
        >
          <div className="eg-row">
            <strong>{toast.title}</strong>
            <span className="eg-toolbar__spacer" />
            <button
              type="button"
              className="eg-collapse"
              onClick={() => dismiss(toast.id)}
            >
              <span aria-hidden="true">✕</span>
              <span className="eg-visually-hidden">Dismiss: {toast.title}</span>
            </button>
          </div>
          <div className="eg-lane__meta">{toast.message}</div>
          {toast.action ? (
            <div className="eg-row">
              {toast.action.href === undefined ? (
                <button
                  type="button"
                  className="eg-button"
                  onClick={toast.action.onAction}
                >
                  {toast.action.label}
                </button>
              ) : (
                <a
                  className="eg-button"
                  href={toast.action.href}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {toast.action.label}
                </a>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
