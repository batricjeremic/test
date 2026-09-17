/**
 * Hub-local view types.
 *
 * Everything the hub shares with the BFF lives in `@eg/shared` and is
 * imported from there. This file holds only what never leaves the
 * browser: drag payloads and view state.
 */
import type { BoardGrouping } from '@eg/shared';

/**
 * Which contribution the hub was loaded for. Both `vss-extension.json`
 * contributions point at the same bundle; `main.tsx` picks the view from
 * the contribution id, falling back to `?view=` for local development.
 */
export type HubViewId = 'board' | 'admin';

/**
 * Payload attached to a `@dnd-kit` draggable card
 * (`useDraggable({ id, data })`). Everything a drop target needs to
 * decide, without reaching back into the store.
 */
export type CardDragData = {
  readonly kind: 'card';
  readonly workItemId: number;
  /** The rev the user is looking at; sent with the move request. */
  readonly rev: number;
  readonly projectId: string;
  readonly teamId: string;
  /** Lane the card is being dragged out of. */
  readonly swimlaneId: string;
  readonly fromCanonicalColumnId: string;
  /**
   * Canonical columns this card's team has a mapping row for. A drop
   * anywhere else is refused at drag start and shown as blocked.
   */
  readonly allowedCanonicalColumnIds: readonly string[];
  /** False for read-only projects: the card must not be draggable. */
  readonly writable: boolean;
};

/** Payload attached to a `@dnd-kit` droppable column cell. */
export type ColumnDropData = {
  readonly kind: 'column';
  readonly canonicalColumnId: string;
  readonly swimlaneId: string;
};

/** Why a drop target is blocked for the card currently being dragged. */
export type DropRefusalReason =
  | 'not-writable'
  | 'mapping-missing'
  | 'card-locked'
  | 'unmapped-lane'
  | 'same-column';

/** Result of asking whether this card may be dropped on this cell. */
export type DropDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DropRefusalReason };

/** A card's interaction state, rendered as spinner, dimming or normal. */
export type CardInteractionState =
  | 'idle'
  | 'dragging'
  /** Locked while its move is in flight; no second drag until it lands. */
  | 'saving'
  | 'read-only';

/** Lane collapse and card selection: view state, never sent anywhere. */
export type BoardViewState = {
  grouping: BoardGrouping;
  collapsedSwimlaneIds: readonly string[];
  /** Work item whose native form should open in a dialog, or null. */
  openWorkItemId: number | null;
};

/** The empty view state a board view starts from. */
export const initialBoardViewState: BoardViewState = {
  grouping: 'person',
  collapsedSwimlaneIds: [],
  openWorkItemId: null,
};
