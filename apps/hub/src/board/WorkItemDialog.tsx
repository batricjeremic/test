/**
 * Card detail: the native work item form, in a dialog.
 *
 * We do not rebuild the form. The card links out to the real one, framed
 * so the user keeps their place on the board, with a plain link out for
 * anyone whose browser or host refuses the frame.
 */
import { useEffect, useRef } from 'react';
import type { BoardCard } from '@eg/shared';

export type WorkItemDialogProps = {
  card: BoardCard;
  projectName: string;
  /** Deep link to the native form, from the host. */
  url: string;
  onClose(): void;
};

export function WorkItemDialog({
  card,
  projectName,
  url,
  onClose,
}: WorkItemDialogProps): JSX.Element {
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

  const title = `${card.type} ${card.workItemId}: ${card.title}`;

  return (
    <div
      className="eg-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="eg-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="eg-dialog__head">
          <h2 className="eg-dialog__title">{title}</h2>
          <span className="eg-badge" data-tone="project">
            {projectName}
          </span>
          <span className="eg-toolbar__spacer" />
          <a
            className="eg-button"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in Azure DevOps
          </a>
          <button
            type="button"
            className="eg-button"
            ref={closeRef}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <iframe
          className="eg-dialog__frame"
          title={title}
          src={url}
          loading="lazy"
        />
      </div>
    </div>
  );
}
