/**
 * Card detail: a drawer on the right, and the NATIVE form on demand.
 *
 * This replaces a dialog that framed `dev.azure.com` in an iframe. That
 * was never going to work: Azure DevOps refuses to be framed, so the
 * dialog rendered "dev.azure.com refused to connect" and nothing else.
 *
 * So the split is explicit. What the board already knows — who owns the
 * card, which team and column it sits in, what is left on it — is shown
 * here, immediately, with no request. Editing opens Azure DevOps' own
 * form over the frame through the host service, which is the real one:
 * save, history, attachments, rules. We do not rebuild it, and we do not
 * pretend to frame it.
 *
 * A drawer rather than a modal because the board behind it is the
 * context: which lane this card sits in is half of what the reader is
 * looking at.
 */
import { useEffect, useRef } from 'react';
import type { BoardCard } from '@eg/shared';

export type WorkItemDrawerProps = {
  card: BoardCard;
  projectName: string;
  teamName: string;
  columnName: string;
  /** Deep link, for the fallback and for opening in a new tab. */
  url: string;
  /** The host's native form. Resolves false when it is not available. */
  onOpenNative: (workItemId: number) => Promise<boolean>;
  onClose(): void;
};

const NOT_SET = '—';

export function WorkItemDrawer({
  card,
  projectName,
  teamName,
  columnName,
  url,
  onOpenNative,
  onClose,
}: WorkItemDrawerProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const title = `${card.type} ${card.workItemId}`;

  const openNative = (): void => {
    void (async () => {
      // If the host cannot open its own form, the link is still there
      // rather than a button that quietly does nothing.
      const opened = await onOpenNative(card.workItemId);
      if (!opened) window.open(url, '_blank', 'noreferrer,noopener');
    })();
  };

  return (
    <div
      className="eg-drawer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="eg-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${title}: ${card.title}`}
      >
        <header className="eg-drawer__head">
          <span className="eg-count">{title}</span>
          <span className="eg-toolbar__spacer" />
          <button
            type="button"
            className="eg-button"
            ref={closeRef}
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <h2 className="eg-drawer__title">{card.title}</h2>

        <dl className="eg-drawer__facts">
          <dt>Assigned to</dt>
          <dd>{card.assignedTo?.displayName ?? 'Unassigned'}</dd>
          <dt>Project</dt>
          <dd>{projectName}</dd>
          <dt>Team</dt>
          <dd>{teamName}</dd>
          <dt>Column</dt>
          <dd>{columnName}</dd>
          <dt>State</dt>
          <dd>{card.state || NOT_SET}</dd>
          <dt>Remaining</dt>
          <dd>
            {card.remainingWork === null ? NOT_SET : `${card.remainingWork} h`}
          </dd>
          <dt>Tags</dt>
          <dd>{card.tags.length > 0 ? card.tags.join(', ') : NOT_SET}</dd>
        </dl>

        <div className="eg-drawer__actions">
          <button
            type="button"
            className="eg-button eg-button--primary"
            onClick={openNative}
          >
            Edit in Azure DevOps
          </button>
          <a
            className="eg-button"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in a new tab
          </a>
        </div>
      </aside>
    </div>
  );
}

export default WorkItemDrawer;
