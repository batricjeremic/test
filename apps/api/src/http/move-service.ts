/**
 * `POST /api/moves` — the write path, and the route the whole service
 * exists for.
 *
 * Spec, "Write path". Four rules shape every line below.
 *
 * 1. Resolve the card's owning team, board, iteration and mapping before
 *    anything is written; a wrong team id fails the call outright.
 * 2. Refuse a target column that team has no mapping row for. The cheap
 *    half of that check runs off the config store alone, so a board that
 *    maps the column nowhere is refused without one Azure DevOps call.
 * 3. Patch Azure DevOps **as the calling user**, never as the service
 *    identity, carrying the rev the user's card held as a `test` op.
 *    Column and state go in one document when the mapping sets a state.
 * 4. A move is never reported as saved until Azure DevOps confirms it,
 *    and every attempt is audited — success or failure. A failed audit
 *    write never turns a successful move into a reported failure.
 */
import { UNMAPPED_COLUMN_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardDefinition,
  IdentityRef,
  MoveFailure,
  MoveRequest,
  MoveResult,
  NewAuditEntry,
} from '@eg/shared';
import { buildColumnMovePatch } from '../ado/patch.js';
import type { AdoWorkItem } from '../ado/types.js';
import {
  ADO_FIELDS,
  readIdentityField,
  readStringField,
} from '../ado/types.js';
import {
  canWriteProject,
  serviceCallOptions,
  userCallOptions,
} from '../auth/identity.js';
import type { CacheInvalidator } from '../cache/index.js';
import type { CardCandidate, TeamBoardContext } from '../domain/index.js';
import {
  buildBoardCard,
  dedupeCardCandidates,
  resolveTeamColumnForCanonical,
  toIdentityRef,
} from '../domain/index.js';
import type { AppError } from '../errors.js';
import {
  MappingMissingError,
  NotFoundError,
  PermissionDeniedError,
  RevisionConflictError,
  toAppError,
  ValidationError,
} from '../errors.js';
import type { DeltaPublisher } from '../realtime/index.js';
import type {
  CallerAcl,
  CallerIdentity,
  CallOptions,
  Clock,
  Logger,
} from '../ports.js';
import type { BoardContext, BoardContextDeps } from './board-context.js';
import { loadBoardContext, loadBoardDefinition } from './board-context.js';
import type { MoveFailureContext } from './move-failures.js';
import { statusForFailure, toMoveFailure } from './move-failures.js';

export interface MoveDeps extends BoardContextDeps {
  readonly clock: Clock;
  readonly invalidator: CacheInvalidator;
  readonly deltas: DeltaPublisher;
  /** Organisation URL, for the work item deep link on a toast. */
  readonly adoOrgUrl: string;
}

export interface MoveInput {
  readonly request: MoveRequest;
  readonly identity: CallerIdentity;
  readonly acl: CallerAcl;
  readonly options: CallOptions;
  readonly logger: Logger;
}

/** The HTTP answer: a typed result, and the status it is served with. */
export interface MoveOutcome {
  readonly status: number;
  readonly result: MoveResult;
}

/** The card, its team and its mapping, all resolved server side. */
interface ResolvedCard {
  readonly card: BoardCard;
  readonly team: TeamBoardContext;
  readonly workItem: AdoWorkItem;
  readonly changedBy: IdentityRef | null;
  readonly changedAt: string | null;
}

const iterationIdOf = (workItem: AdoWorkItem): string =>
  readStringField(workItem.fields, ADO_FIELDS.iterationId) ??
  readStringField(workItem.fields, ADO_FIELDS.iterationPath) ??
  'unknown-iteration';

const changedAtOf = (workItem: AdoWorkItem): string | null => {
  const raw = readStringField(workItem.fields, 'System.ChangedDate');
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export class MoveService {
  readonly #deps: MoveDeps;

  constructor(deps: MoveDeps) {
    this.#deps = deps;
  }

  /**
   * One drag. Returns a typed result for every outcome in the spec's
   * failure table; anything that is not a write failure — no board, a
   * malformed body — is thrown and answered as an `ApiError`.
   */
  async apply(input: MoveInput): Promise<MoveOutcome> {
    const { request, options } = input;
    const definition = await loadBoardDefinition(
      this.#deps.config,
      request.boardId,
      options,
    );

    const refusal = await this.#preCheckMapping(definition, input);
    if (refusal !== null) return refusal;

    const context = await loadBoardContext(this.#deps, definition, options);
    const resolved = await this.#resolveCard(context, request, options);
    const failureContext = this.#failureContext(context, request, resolved);

    try {
      return await this.#write(input, context, resolved, failureContext);
    } catch (error) {
      const appError = toAppError(error);
      if (!isMoveFailure(appError)) throw appError;
      const failure = toMoveFailure(appError, failureContext);
      input.logger.warn('move refused', {
        boardId: request.boardId,
        workItemId: request.workItemId,
        teamId: resolved.team.teamId,
        reason: failure.reason,
        code: appError.code,
      });
      return this.#fail(input, failure, resolved.card);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Steps                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * The config-only half of the mapping check. A target column that no
   * team on this board maps is refused here, which is before the first
   * Azure DevOps call is made — the drag should never have been allowed
   * to start, and we are not going to read a work item to say so.
   */
  async #preCheckMapping(
    definition: BoardDefinition,
    input: MoveInput,
  ): Promise<MoveOutcome | null> {
    const { request, options } = input;
    const config = this.#deps.config;
    const [columns, mappings] = await Promise.all([
      config.listCanonicalColumns(definition.id, options),
      config.listColumnMappings(definition.id, options),
    ]);

    const target = columns.find(
      (column) => column.id === request.toCanonicalColumnId,
    );

    const unusable =
      target === undefined ||
      request.toCanonicalColumnId === UNMAPPED_COLUMN_ID;
    if (unusable) {
      throw new ValidationError(
        `Column ${request.toCanonicalColumnId} is not on board ${definition.id}`,
        { details: { boardId: definition.id } },
      );
    }
    if (mappings.some((row) => row.canonicalColumnId === target.id)) {
      return null;
    }

    const sources = await config.listBoardSources(definition.id, options);
    const first = sources[0];
    if (first === undefined) {
      throw new MappingMissingError(
        `Board ${definition.id} has no team sources`,
        { details: { boardId: definition.id } },
      );
    }
    const failure: MoveFailure = {
      reason: 'mapping-missing',
      message: `No team on this board has a column mapped to "${target.name}". Ask an admin to map it before moving cards there.`,
      projectId: first.projectId,
      teamId: first.teamId,
      teamName: '',
      canonicalColumnId: target.id,
      canonicalColumnName: target.name,
    };
    input.logger.warn('move refused before any upstream call', {
      boardId: definition.id,
      workItemId: request.workItemId,
      reason: failure.reason,
      canonicalColumnId: target.id,
    });
    return this.#fail(input, failure, null);
  }

  /** The work item, and the board team whose area path owns it. */
  async #resolveCard(
    context: BoardContext,
    request: MoveRequest,
    options: CallOptions,
  ): Promise<ResolvedCard> {
    const [workItem] = await this.#deps.ado.getWorkItemsBatch(
      { ids: [request.workItemId], errorPolicy: 'omit' },
      serviceCallOptions(options),
    );
    if (workItem === undefined) {
      throw new NotFoundError(`Work item ${request.workItemId} was not found`, {
        details: { workItemId: request.workItemId },
      });
    }

    const iterationId = iterationIdOf(workItem);
    const owned: CardCandidate[] = [];
    for (const entry of context.entries) {
      const candidate = buildBoardCard(workItem, {
        index: context.index,
        areaPaths: context.areaPathIndex,
        team: entry.team,
        iterationId,
      });
      // Only the team whose area path owns the card may be written to:
      // a wrong team id names the wrong board field and fails outright.
      if (candidate !== null && candidate.owned) owned.push(candidate);
    }
    const [card] = dedupeCardCandidates(owned);
    const team =
      card === undefined
        ? undefined
        : context.entries.find((entry) => entry.team.teamId === card.teamId)
            ?.team;
    if (card === undefined || team === undefined) {
      throw new NotFoundError(
        `Work item ${request.workItemId} is not on board ${context.definition.id}`,
        { details: { workItemId: request.workItemId } },
      );
    }

    return {
      card,
      team,
      workItem,
      changedBy: toIdentityRef(
        readIdentityField(workItem.fields, 'System.ChangedBy'),
      ),
      changedAt: changedAtOf(workItem),
    };
  }

  /**
   * Mapping, permission, revision, then the patch. Each refusal is a
   * typed failure; only Azure DevOps saying yes is a saved move.
   */
  async #write(
    input: MoveInput,
    context: BoardContext,
    resolved: ResolvedCard,
    failureContext: MoveFailureContext,
  ): Promise<MoveOutcome> {
    const { request, options } = input;
    const reverse = resolveTeamColumnForCanonical(
      context.index,
      resolved.team.teamId,
      request.toCanonicalColumnId,
    );
    if (reverse.kind === 'refused') {
      input.logger.warn('move refused, no mapping row for that team', {
        boardId: request.boardId,
        workItemId: request.workItemId,
        teamId: resolved.team.teamId,
        reason: reverse.reason,
      });
      return this.#fail(input, reverse.failure, resolved.card);
    }

    if (!canWriteProject(input.acl, resolved.team.projectId)) {
      throw new PermissionDeniedError(
        `Caller may not write in project ${resolved.team.projectId}`,
        { details: { projectId: resolved.team.projectId } },
      );
    }

    // The rev the user's card held goes on the wire as a `test` op, but
    // a mismatch we can already see costs nobody a round trip.
    if (resolved.card.rev !== request.rev) {
      throw new RevisionConflictError(
        `Work item ${request.workItemId} is at rev ${resolved.card.rev}`,
        resolved.card.rev,
        { details: { workItemId: request.workItemId } },
      );
    }

    const patch = buildColumnMovePatch({
      boardId: reverse.adoBoardId,
      rev: request.rev,
      column: reverse.sourceColumnName,
      done: reverse.done,
      targetState: reverse.targetState,
    });
    const updated = await this.#deps.ado.updateWorkItem(
      request.workItemId,
      patch,
      userCallOptions(input.identity, options),
    );

    const card = this.#cardOf(context, resolved.team, updated, resolved.card);
    const stateChanged =
      reverse.targetState !== null && card.state !== resolved.card.state;

    await this.#audit(input, {
      outcome: 'success',
      newRev: card.rev,
      stateChanged,
    });
    await this.#invalidateAndPublish(input, resolved.card, card);

    input.logger.info('move applied', {
      boardId: request.boardId,
      workItemId: request.workItemId,
      teamId: resolved.team.teamId,
      from: request.fromCanonicalColumnId,
      to: request.toCanonicalColumnId,
      newRev: card.rev,
      stateChanged,
    });
    return {
      status: 200,
      result: {
        status: 'applied',
        workItemId: request.workItemId,
        card,
        stateChanged,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  #cardOf(
    context: BoardContext,
    team: TeamBoardContext,
    workItem: AdoWorkItem,
    previous: BoardCard,
  ): BoardCard {
    const candidate = buildBoardCard(workItem, {
      index: context.index,
      areaPaths: context.areaPathIndex,
      team,
      iterationId: iterationIdOf(workItem),
    });
    return candidate?.card ?? { ...previous, rev: workItem.rev };
  }

  #failureContext(
    context: BoardContext,
    request: MoveRequest,
    resolved: ResolvedCard,
  ): MoveFailureContext {
    const target = context.index.columnsById.get(request.toCanonicalColumnId);
    const reverse = resolveTeamColumnForCanonical(
      context.index,
      resolved.team.teamId,
      request.toCanonicalColumnId,
    );
    return {
      card: resolved.card,
      team: resolved.team,
      index: context.index,
      canonicalColumnId: request.toCanonicalColumnId,
      canonicalColumnName: target?.name ?? request.toCanonicalColumnId,
      targetState: reverse.kind === 'mapped' ? reverse.targetState : null,
      workItemUrl: this.#workItemUrl(request.workItemId),
      changedBy: resolved.changedBy,
      changedAt: resolved.changedAt,
    };
  }

  #workItemUrl(workItemId: number): string {
    return `${this.#deps.adoOrgUrl}/_workitems/edit/${workItemId}`;
  }

  /** A failed attempt: audited like any other, then answered. */
  async #fail(
    input: MoveInput,
    failure: MoveFailure,
    card: BoardCard | null,
  ): Promise<MoveOutcome> {
    await this.#audit(input, { outcome: 'failure', failure });
    return {
      status: statusForFailure(failure),
      result: {
        status: 'failed',
        workItemId: input.request.workItemId,
        failure,
        card,
      },
    };
  }

  /**
   * "Every attempt is written to `AuditEntry`, including the failures,
   * because the first support question will be 'I moved that card and it
   * went back'." An audit store that is down is logged loudly and never
   * allowed to rewrite the outcome of a move Azure DevOps confirmed.
   */
  async #audit(
    input: MoveInput,
    result: NewAuditEntry['result'],
  ): Promise<void> {
    const entry: NewAuditEntry = {
      boardId: input.request.boardId,
      actor: input.identity.descriptor,
      workItemId: input.request.workItemId,
      from: input.request.fromCanonicalColumnId,
      to: input.request.toCanonicalColumnId,
      result,
      timestamp: this.#deps.clock.now().toISOString(),
      traceId: input.options.traceId,
    };
    try {
      await this.#deps.config.appendAudit(entry, input.options);
    } catch (error) {
      input.logger.error('audit append failed', {
        boardId: entry.boardId,
        workItemId: entry.workItemId,
        outcome: result.outcome,
        reason: toAppError(error).code,
      });
    }
  }

  /** Own write: drop the board's snapshots, push the delta. */
  async #invalidateAndPublish(
    input: MoveInput,
    previous: BoardCard,
    card: BoardCard,
  ): Promise<void> {
    const options = input.options;
    try {
      await this.#deps.invalidator.invalidateBoardSnapshots(
        input.request.boardId,
        options,
      );
      await this.#deps.deltas.publishDelta(
        {
          boardId: input.request.boardId,
          origin: 'own-write',
          traceId: options.traceId,
          delta: {
            kind: 'card-moved',
            workItemId: card.workItemId,
            rev: card.rev,
            fromCanonicalColumnId: previous.canonicalColumnId,
            toCanonicalColumnId: card.canonicalColumnId,
            sourceColumn: card.sourceColumn,
            state: card.state,
            assignedTo: card.assignedTo,
          },
        },
        options,
      );
    } catch (error) {
      // The move is saved. A cache or socket problem is not the user's.
      input.logger.warn('post-write fan-out failed', {
        boardId: input.request.boardId,
        workItemId: card.workItemId,
        reason: toAppError(error).code,
      });
    }
  }
}

/** Errors that mean "the move did not happen", not "the request was bad". */
function isMoveFailure(error: AppError): boolean {
  switch (error.code) {
    case 'revision_conflict':
    case 'rule_violation':
    case 'transition_not_allowed':
    case 'permission_denied':
    case 'mapping_missing':
    case 'rate_limited':
    case 'upstream_timeout':
    case 'upstream_failed':
    case 'service_unavailable':
      return true;
    default:
      return false;
  }
}
