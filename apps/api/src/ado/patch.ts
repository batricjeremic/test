/**
 * JSON Patch documents for the write path, and the two other write
 * payloads the spec lists.
 *
 * Serves "Write path". Two rules are encoded here and nowhere else:
 *
 * 1. Every document opens with `{ op: 'test', path: '/rev' }` carrying
 *    the revision the user's card held. If someone moved the card in
 *    between, Azure DevOps rejects the patch instead of overwriting
 *    their change — the concurrency guarantee is the service's, not a
 *    read-then-write race of ours.
 * 2. When the mapping carries a `targetState`, the state write goes in
 *    the SAME document as the column write, so column and state can
 *    never diverge.
 */
import { ValidationError } from '../errors.js';
import {
  ADO_FIELDS,
  adoTaskboardWorkItemUpdateSchema,
  fieldPath,
  kanbanColumnDoneFieldName,
  kanbanColumnFieldName,
  type AdoBoardFields,
  type AdoJsonPatchDocument,
  type AdoSubscriptionRequest,
  type AdoTaskboardWorkItemUpdate,
} from './types.js';

/** JSON Patch path for the work item revision the `test` op guards. */
export const ADO_REV_PATH = '/rev';

const assertRev = (rev: number): void => {
  if (!Number.isInteger(rev) || rev < 0) {
    throw new ValidationError('Work item rev must be a non-negative integer');
  }
};

/**
 * The optimistic-concurrency guard. Exported on its own so a caller
 * composing an unusual patch cannot forget it.
 */
export function revisionTestOperation(rev: number): AdoJsonPatchDocument {
  assertRev(rev);
  return [{ op: 'test', path: ADO_REV_PATH, value: rev }];
}

export interface ColumnMovePatchInput {
  /** The team's Azure DevOps board id, for the `WEF_<boardId>_` field. */
  readonly boardId: string;
  /** The revision the user's card carried. */
  readonly rev: number;
  /** Target board column name, as the team's board spells it. */
  readonly column: string;
  /**
   * The `.Done` half of a split column. `null` or omitted when the
   * target column is not split, in which case the field is not written.
   */
  readonly done?: boolean | null;
  /**
   * From `ColumnMapping.targetState`. `null` means "move the board
   * column only", exactly as a native board behaves when a column is
   * not bound to a state.
   */
  readonly targetState?: string | null;
  /**
   * The board document's own `fields`, which are authoritative for the
   * WEF field names. Preferred over deriving them from the board id.
   */
  readonly boardFields?: AdoBoardFields | null;
}

/** The field reference names a move writes, board document first. */
export function resolveColumnFieldNames(
  boardId: string,
  boardFields?: AdoBoardFields | null,
): { readonly column: string; readonly done: string } {
  const column =
    boardFields?.columnField.referenceName ?? kanbanColumnFieldName(boardId);
  const done =
    boardFields?.doneField?.referenceName ?? kanbanColumnDoneFieldName(boardId);
  return { column, done };
}

/**
 * The document for a card dragged between canonical columns: rev test,
 * board column, optional split-column Done flag, optional state.
 */
export function buildColumnMovePatch(
  input: ColumnMovePatchInput,
): AdoJsonPatchDocument {
  if (input.boardId.length === 0) {
    throw new ValidationError('Board id is required to build a move patch');
  }
  if (input.column.length === 0) {
    throw new ValidationError('Target column is required to build a patch');
  }
  const names = resolveColumnFieldNames(input.boardId, input.boardFields);
  const patch: AdoJsonPatchDocument = [
    ...revisionTestOperation(input.rev),
    { op: 'add', path: fieldPath(names.column), value: input.column },
  ];
  if (typeof input.done === 'boolean') {
    patch.push({ op: 'add', path: fieldPath(names.done), value: input.done });
  }
  if (typeof input.targetState === 'string' && input.targetState.length > 0) {
    patch.push({
      op: 'add',
      path: fieldPath(ADO_FIELDS.state),
      value: input.targetState,
    });
  }
  return patch;
}

export interface ReassignPatchInput {
  readonly rev: number;
  /**
   * The identity to assign, as Azure DevOps accepts it: a unique name
   * or a descriptor. `null` clears the assignment.
   */
  readonly assignee: string | null;
}

/** `PATCH /_apis/wit/workitems/{id}` on `/fields/System.AssignedTo`. */
export function buildReassignPatch(
  input: ReassignPatchInput,
): AdoJsonPatchDocument {
  const patch: AdoJsonPatchDocument = revisionTestOperation(input.rev);
  if (input.assignee === null || input.assignee.length === 0) {
    patch.push({ op: 'remove', path: fieldPath(ADO_FIELDS.assignedTo) });
    return patch;
  }
  patch.push({
    op: 'add',
    path: fieldPath(ADO_FIELDS.assignedTo),
    value: input.assignee,
  });
  return patch;
}

/**
 * `PATCH .../taskboardworkitems/{iterationId}/{workItemId}`. Moves the
 * taskboard card only; it does not change `System.State`, which is why
 * a move that must also transition state uses the work item patch above.
 */
export function buildTaskboardUpdate(
  newColumn: string,
): AdoTaskboardWorkItemUpdate {
  const parsed = adoTaskboardWorkItemUpdateSchema.safeParse({ newColumn });
  if (!parsed.success || parsed.data.newColumn.length === 0) {
    throw new ValidationError('Taskboard column name is required');
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Service hook subscription                                           */
/* ------------------------------------------------------------------ */

export const ADO_SERVICE_HOOK_PUBLISHER_ID = 'tfs';
export const ADO_SERVICE_HOOK_CONSUMER_ID = 'webHooks';
export const ADO_SERVICE_HOOK_ACTION_ID = 'httpRequest';
export const ADO_WORK_ITEM_UPDATED_EVENT = 'workitem.updated';
export const ADO_WORK_ITEM_UPDATED_RESOURCE_VERSION = '1.0';

export interface WorkItemUpdatedSubscriptionInput {
  /** One subscription per project, as the spec's write table says. */
  readonly projectId: string;
  /** Absolute URL of our webhook endpoint. */
  readonly webhookUrl: string;
  /** Optional narrowing to one area path. */
  readonly areaPath?: string | null;
  /**
   * Credentials Azure DevOps presents to our webhook. Secrets: they go
   * into the request body and must never reach a log line.
   */
  readonly basicAuthUsername?: string | null;
  readonly basicAuthPassword?: string | null;
}

/** `POST /_apis/hooks/subscriptions` body for `workitem.updated`. */
export function buildWorkItemUpdatedSubscription(
  input: WorkItemUpdatedSubscriptionInput,
): AdoSubscriptionRequest {
  if (input.projectId.length === 0) {
    throw new ValidationError('Project id is required for a subscription');
  }
  try {
    void new URL(input.webhookUrl);
  } catch {
    throw new ValidationError('Webhook URL must be an absolute URL');
  }
  const publisherInputs: Record<string, string> = {
    projectId: input.projectId,
  };
  if (input.areaPath !== null && input.areaPath !== undefined) {
    publisherInputs['areaPath'] = input.areaPath;
  }
  const consumerInputs: Record<string, string> = {
    url: input.webhookUrl,
    resourceDetailsToSend: 'all',
    messagesToSend: 'none',
    detailedMessagesToSend: 'none',
  };
  if (
    input.basicAuthUsername !== null &&
    input.basicAuthUsername !== undefined
  ) {
    consumerInputs['basicAuthUsername'] = input.basicAuthUsername;
  }
  if (
    input.basicAuthPassword !== null &&
    input.basicAuthPassword !== undefined
  ) {
    consumerInputs['basicAuthPassword'] = input.basicAuthPassword;
  }
  return {
    publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
    eventType: ADO_WORK_ITEM_UPDATED_EVENT,
    resourceVersion: ADO_WORK_ITEM_UPDATED_RESOURCE_VERSION,
    consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
    consumerActionId: ADO_SERVICE_HOOK_ACTION_ID,
    publisherInputs,
    consumerInputs,
  };
}
