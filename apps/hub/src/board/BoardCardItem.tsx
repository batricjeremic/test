/**
 * One card.
 *
 * Memoised on purpose: a board can carry 400 of these and a drag must
 * not re-render any of them. A card the caller cannot write is not a
 * drag source at all — the spec wants the refusal visible before the
 * user tries — and a card with a move in flight is locked with a
 * spinner until Azure DevOps has answered.
 */
import { memo, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard, BoardTeamView } from '@eg/shared';
import { buildCardDragData } from '../state';
import type { CardInteractionState } from '../types';
import { describeCard, formatHours } from './format';

export type BoardCardItemProps = {
  card: BoardCard;
  /** The card's owning team view: writability and mapped columns. */
  team: BoardTeamView | null;
  laneId: string;
  columnName: string;
  /** A move for this card is in flight. */
  locked: boolean;
  /** Person lanes carry a project badge; team lanes do not need one. */
  showProjectBadge: boolean;
  openWorkItem(workItemId: number): void;
};

function BoardCardItemImpl({
  card,
  team,
  laneId,
  columnName,
  locked,
  showProjectBadge,
  openWorkItem,
}: BoardCardItemProps): JSX.Element {
  const writable = team?.writable === true;
  const draggable = writable && !locked;

  const dragData = useMemo(
    () => buildCardDragData(card, team, laneId),
    [card, team, laneId],
  );

  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `card:${card.workItemId}`,
    data: dragData,
    disabled: !draggable,
  });

  const state: CardInteractionState = locked
    ? 'saving'
    : isDragging
      ? 'dragging'
      : writable
        ? 'idle'
        : 'read-only';

  const unmapped = card.canonicalColumnId === UNMAPPED_COLUMN_ID;
  const projectName = team?.iteration.projectName ?? card.project;
  const teamName = team?.iteration.teamName ?? card.teamId;

  const style: CSSProperties | undefined = isDragging
    ? { opacity: 0.4 }
    : undefined;

  return (
    <article
      ref={setNodeRef}
      className="eg-card"
      data-state={state}
      data-draggable={draggable ? 'true' : 'false'}
      data-work-item-id={card.workItemId}
      style={style}
      aria-label={describeCard(card, columnName)}
      {...(draggable ? {} : { 'aria-roledescription': 'card' })}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      <div className="eg-card__head">
        <button
          type="button"
          className="eg-card__open"
          onClick={() => openWorkItem(card.workItemId)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {card.title}
        </button>
        {locked ? (
          <span className="eg-spinner" role="status" aria-label="Saving" />
        ) : null}
      </div>

      <div className="eg-card__meta">
        <span>
          {card.type} {card.workItemId}
        </span>
        <span aria-hidden="true">·</span>
        <span>{card.assignedTo?.displayName ?? 'Unassigned'}</span>
        <span aria-hidden="true">·</span>
        <span title="Remaining work">{formatHours(card.remainingWork)}</span>
        <span aria-hidden="true">·</span>
        <span>{card.state}</span>
      </div>

      <div className="eg-card__badges">
        {showProjectBadge ? (
          <span className="eg-badge" data-tone="project">
            {projectName}
          </span>
        ) : null}
        <span className="eg-badge">{teamName}</span>
        {unmapped ? (
          <span className="eg-badge" data-tone="warning">
            {teamName} column “{card.sourceColumn}” is not mapped
          </span>
        ) : null}
        {!writable ? <span className="eg-badge">Read only</span> : null}
        {card.tags.map((tag) => (
          <span className="eg-badge" key={tag}>
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}

export const BoardCardItem = memo(BoardCardItemImpl);
