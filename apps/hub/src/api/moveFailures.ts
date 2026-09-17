/**
 * Transport failures become typed move failures.
 *
 * The BFF answers a move with a 200 and a `MoveResult`, so a domain
 * failure arrives already typed. Everything else — a 401, a 409 with no
 * body, a 429, a dropped connection, a timeout — is mapped here onto the
 * same `MoveFailureReason` union, so a caller never has to look at a
 * `Response` to decide what to tell the user.
 */
import { moveFailureSchema } from '@eg/shared';
import type { BoardCard, MoveFailure } from '@eg/shared';
import { isApiClientError } from './errors';
import type { ApiClientError } from './errors';

/**
 * What the caller knows about the card, used to fill the fields a
 * synthesised failure needs. `useMove` passes the card it moved.
 */
export type MoveFailureContext = {
  card?: BoardCard | null;
  /** Human-readable project name, when the caller has one. */
  projectName?: string | null;
  /** Human-readable team name, when the caller has one. */
  teamName?: string | null;
  /** Canonical column the card was dropped on. */
  canonicalColumnId?: string | null;
  canonicalColumnName?: string | null;
  /** Deep link used by the rule-violation toast's button. */
  workItemUrl?: string | null;
};

const UNKNOWN = 'unknown';

/**
 * Maps any thrown value onto a `MoveFailure`.
 *
 * A BFF error envelope whose `code` is one of the shared failure reasons
 * is honoured as-is (its `details` are merged in and validated). Anything
 * else is classified by status: 401/403 is permission denied, 409 is a
 * revision conflict, 404/422 with a mapping code is a missing mapping,
 * and every other transport failure is reported as the service being
 * unavailable rather than dressed up as something more specific.
 */
export function toMoveFailure(
  error: unknown,
  context: MoveFailureContext = {},
): MoveFailure {
  const fromEnvelope = failureFromErrorEnvelope(error, context);
  if (fromEnvelope) return fromEnvelope;

  if (!isApiClientError(error)) {
    return serviceUnavailable(
      error instanceof Error ? error.message : 'The move could not be sent.',
      null,
    );
  }

  switch (error.kind) {
    case 'timeout':
      return serviceUnavailable(
        'The board service did not answer in time. The card was not moved.',
        null,
      );
    case 'network':
      return serviceUnavailable(
        'The board service could not be reached. The card was not moved.',
        null,
      );
    case 'aborted':
      return serviceUnavailable('The move was cancelled.', null);
    case 'invalid-response':
      return serviceUnavailable(
        'The board service returned something we could not read.',
        null,
      );
    case 'http':
      return failureFromStatus(error, context);
    default:
      return serviceUnavailable('The move could not be completed.', null);
  }
}

function failureFromStatus(
  error: ApiClientError,
  context: MoveFailureContext,
): MoveFailure {
  const status = error.status ?? 0;

  if (status === 401 || status === 403) {
    return {
      reason: 'permission-denied',
      message:
        error.apiError?.message ??
        'You do not have permission to change work items in that project.',
      projectId: context.card?.project ?? context.projectName ?? UNKNOWN,
      projectName: context.projectName ?? context.card?.project ?? '',
    };
  }

  if (status === 409 || status === 412) {
    return {
      reason: 'revision-conflict',
      message:
        error.apiError?.message ??
        'This card changed since the board loaded. It has been put back.',
      currentRev: context.card?.rev ?? 0,
      currentCanonicalColumnId: context.card?.canonicalColumnId ?? UNKNOWN,
      currentColumnName: context.canonicalColumnName ?? '',
      changedBy: null,
      changedAt: null,
    };
  }

  if (error.apiError?.code === 'mapping-missing') {
    return mappingMissing(error.apiError.message, context);
  }

  return serviceUnavailable(
    error.apiError?.message ??
      'The board service is busy. The card was not moved.',
    error.retryAfterSeconds,
  );
}

/**
 * A BFF error body may already carry a typed failure:
 * `{ code: <reason>, message, details: { ... } }`. Validated with the
 * shared schema, never cast.
 */
function failureFromErrorEnvelope(
  error: unknown,
  context: MoveFailureContext,
): MoveFailure | null {
  if (!isApiClientError(error) || !error.apiError) return null;
  const { code, message, details } = error.apiError;
  const candidate = {
    ...(details ?? {}),
    reason: code,
    message,
  };
  const parsed = moveFailureSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  if (code === 'mapping-missing') return mappingMissing(message, context);
  return null;
}

function mappingMissing(
  message: string,
  context: MoveFailureContext,
): MoveFailure {
  return {
    reason: 'mapping-missing',
    message,
    projectId: context.card?.project ?? UNKNOWN,
    teamId: context.card?.teamId ?? UNKNOWN,
    teamName: context.teamName ?? '',
    canonicalColumnId: context.canonicalColumnId ?? UNKNOWN,
    canonicalColumnName: context.canonicalColumnName ?? '',
  };
}

function serviceUnavailable(
  message: string,
  retryAfterSeconds: number | null,
): MoveFailure {
  return {
    reason: 'service-unavailable',
    message,
    attempts: 1,
    retryAfterSeconds,
  };
}
