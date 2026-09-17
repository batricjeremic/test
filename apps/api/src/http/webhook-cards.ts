/**
 * The card lookup the `workitem.updated` hook needs.
 *
 * Spec, "Realtime": on receipt the BFF "invalidates the affected board
 * snapshots and pushes a delta to any open board". A delta needs the card
 * as it now stands, and the hook only names a work item — so this reads
 * that one work item under the service identity and resolves it against
 * the board's (cached) team boards and mapping.
 *
 * Returning null is meaningful: the work item is no longer on that board,
 * and the hub turns that into a `card-removed` delta.
 */
import type { BoardCard } from '@eg/shared';
import { serviceCallOptions } from '../auth/identity.js';
import type { WebhookCardLookup } from '../realtime/index.js';
import type { CallOptions, ConfigStore } from '../ports.js';
import type { BoardContextDeps } from './board-context.js';
import { loadBoardContext, resolveOwnedCard } from './board-context.js';

export interface WebhookCardDeps extends BoardContextDeps {
  readonly config: ConfigStore;
}

export function createWebhookCardLookup(
  deps: WebhookCardDeps,
): WebhookCardLookup {
  return {
    async lookup(
      boardId: string,
      workItemId: number,
      options: CallOptions,
    ): Promise<BoardCard | null> {
      const definition = await deps.config.getBoardDefinition(boardId, options);
      if (definition === null) return null;
      const context = await loadBoardContext(deps, definition, options);
      const [workItem] = await deps.ado.getWorkItemsBatch(
        { ids: [workItemId], errorPolicy: 'omit' },
        serviceCallOptions(options),
      );
      if (workItem === undefined) return null;
      return resolveOwnedCard(context, workItem)?.card ?? null;
    },
  };
}
