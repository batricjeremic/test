/**
 * The spec's write-failure table, as code.
 *
 * | Failure              | What the user sees                          |
 * | Revision conflict    | snaps back, toast names who moved it        |
 * | Rule violation       | toast names the field, button opens the form|
 * | Transition not allowed | toast names the allowed next states       |
 * | Permission denied    | card was not draggable; lane dimmed         |
 * | Mapping missing      | drop refused at drag start                  |
 * | 5xx or throttle      | retried twice, then "the service is busy"   |
 *
 * Every branch produces a typed `MoveFailure`, so the hub renders the
 * right toast without parsing a message. The text comes from
 * `AppError.userMessage`, never from `AppError.message`: the latter may
 * repeat what Azure DevOps said, and only the former is meant for a user.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardCard, IdentityRef, MoveFailure } from '@eg/shared';
import { ADO_FIELDS } from '../ado/types.js';
import type { AppError } from '../errors.js';
import {
  MappingMissingError,
  PermissionDeniedError,
  RateLimitedError,
  RevisionConflictError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../errors.js';
import type { MappingIndex, TeamBoardContext } from '../domain/index.js';
import { mappingMissingFailure } from '../domain/index.js';

/** HTTP status for each typed reason, so the hub can branch on either. */
export function statusForFailure(failure: MoveFailure): number {
  switch (failure.reason) {
    case 'revision-conflict':
      return 409;
    case 'mapping-missing':
      return 409;
    case 'rule-violation':
      return 422;
    case 'transition-not-allowed':
      return 422;
    case 'permission-denied':
      return 403;
    case 'service-unavailable':
      return 503;
  }
}

/** Everything a failure may need to name names, resolved by the caller. */
export interface MoveFailureContext {
  /** The card as Azure DevOps holds it now, when we managed to read it. */
  readonly card: BoardCard | null;
  readonly team: TeamBoardContext | null;
  readonly index: MappingIndex | null;
  readonly canonicalColumnId: string;
  readonly canonicalColumnName: string;
  readonly targetState: string | null;
  /** Deep link for the toast's "open the work item" button. */
  readonly workItemUrl: string;
  readonly changedBy: IdentityRef | null;
  readonly changedAt: string | null;
}

const attemptsOf = (error: AppError): number => {
  const attempts = error.details.attempts;
  return typeof attempts === 'number' && attempts > 0
    ? Math.floor(attempts)
    : 1;
};

const retryAfterOf = (error: AppError): number | null => {
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && value >= 0 ? value : null;
};

/** `Microsoft.VSTS.Common.Activity` reads as `Activity` on a toast. */
export function fieldDisplayName(referenceName: string): string {
  const tail = referenceName.split('.').pop() ?? referenceName;
  return tail.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');
}

/** The canonical column the card sits in now, named for the toast. */
const currentColumnName = (context: MoveFailureContext): string => {
  const card = context.card;
  if (card === null) return '';
  const canonical = context.index?.columnsById.get(card.canonicalColumnId);
  return canonical?.name ?? card.sourceColumn;
};

const conflictMessage = (
  error: RevisionConflictError,
  context: MoveFailureContext,
): string => {
  const who = context.changedBy?.displayName ?? '';
  if (who.length === 0) return error.userMessage;
  return `${who} changed this card a moment ago. It has been refreshed.`;
};

/**
 * One `AppError` to one typed reason. Errors that are not write failures
 * — an unauthenticated caller, a board that does not exist, a malformed
 * body — are not mapped here; they stay `AppError`s and are answered by
 * the app's error handler as an `ApiError`.
 */
export function toMoveFailure(
  error: AppError,
  context: MoveFailureContext,
): MoveFailure {
  if (error instanceof RevisionConflictError) {
    return {
      reason: 'revision-conflict',
      message: conflictMessage(error, context),
      currentRev: error.currentRev ?? context.card?.rev ?? 0,
      currentCanonicalColumnId:
        context.card?.canonicalColumnId ?? UNMAPPED_COLUMN_ID,
      currentColumnName: currentColumnName(context),
      changedBy: context.changedBy,
      changedAt: context.changedAt,
    };
  }

  if (error instanceof TransitionNotAllowedError) {
    return {
      reason: 'transition-not-allowed',
      message: error.userMessage,
      fromState: context.card?.state ?? '',
      toState: context.targetState ?? '',
      allowedStates: [...error.allowedStates],
    };
  }

  if (error instanceof RuleViolationError) {
    const field = error.field ?? ADO_FIELDS.state;
    return {
      reason: 'rule-violation',
      message: error.userMessage,
      field,
      fieldDisplayName: fieldDisplayName(field),
      targetState: context.targetState,
      workItemUrl: context.workItemUrl,
    };
  }

  if (error instanceof PermissionDeniedError) {
    return {
      reason: 'permission-denied',
      message: error.userMessage,
      projectId: context.team?.projectId ?? context.card?.project ?? 'unknown',
      projectName: context.team?.projectName ?? '',
    };
  }

  if (error instanceof MappingMissingError) {
    return mappingMissingFor(context);
  }

  // Everything left is the service being unable to complete the write:
  // a throttle, a 5xx after the retries, a timeout, an unusable answer.
  return {
    reason: 'service-unavailable',
    message:
      error instanceof RateLimitedError
        ? error.userMessage
        : 'The service is busy. Your change was not saved.',
    attempts: attemptsOf(error),
    retryAfterSeconds: retryAfterOf(error),
  };
}

/** The mapping-missing failure, from the index when there is one. */
export function mappingMissingFor(context: MoveFailureContext): MoveFailure {
  const teamId = context.team?.teamId ?? context.card?.teamId ?? '';
  if (context.index !== null && teamId.length > 0) {
    return mappingMissingFailure(
      context.index,
      teamId,
      context.canonicalColumnId,
    );
  }
  const teamLabel = context.team?.teamName ?? teamId;
  return {
    reason: 'mapping-missing',
    message: `${
      teamLabel.length > 0 ? teamLabel : 'That team'
    } has no column mapped to "${context.canonicalColumnName}".`,
    projectId: context.team?.projectId ?? context.card?.project ?? 'unknown',
    teamId: teamId.length > 0 ? teamId : 'unknown',
    teamName: context.team?.teamName ?? '',
    canonicalColumnId: context.canonicalColumnId,
    canonicalColumnName: context.canonicalColumnName,
  };
}
