/**
 * Ports: every boundary the BFF crosses, as an interface with no
 * implementation. Modules depend on these, not on Redis, Postgres, pino
 * or Azure DevOps, so each one can be built and tested with a fake.
 *
 * This file must stay free of runtime code. It imports types only.
 */
import type {
  AuditEntry,
  BoardDefinition,
  BoardGrouping,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  Descriptor,
  PersonOverride,
  RealtimeEnvelope,
  NewAuditEntry,
} from '@eg/shared';
import type { ZodType } from 'zod';
import type {
  AdoBoard,
  AdoBoardReference,
  AdoIterationTimeframe,
  AdoIterationWorkItems,
  AdoJsonPatchDocument,
  AdoRateLimitState,
  AdoSubscription,
  AdoSubscriptionRequest,
  AdoTaskboardColumns,
  AdoTaskboardWorkItemUpdate,
  AdoTeamFieldValues,
  AdoTeamMemberCapacity,
  AdoTeamProjectReference,
  AdoTeamSettingsDaysOff,
  AdoTeamSettingsIteration,
  AdoWebApiTeam,
  AdoWiqlRequest,
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemBatchRequest,
} from './ado/types.js';

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

/**
 * Serves "Auth, permissions and security" and the ExpertGroup logging
 * standard: structured lines carrying a trace id, never a secret and
 * never personal data. Log identity descriptors and work item ids, not
 * display names or emails.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Structured fields merged into one log line. Values must be safe. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  /** Correlation id emitted on every line this logger writes. */
  readonly traceId: string;
  /** Derives a logger with extra bindings, keeping the trace id. */
  child(bindings: LogFields): Logger;
  /** Derives a logger for a new trace, keeping the current bindings. */
  withTraceId(traceId: string): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/**
 * Serves "Capacity and the per-person view" and "Iteration alignment":
 * working-day and sprint-progress maths must be testable without the
 * wall clock.
 */
export interface Clock {
  now(): Date;
}

/* ------------------------------------------------------------------ */
/* Azure DevOps client                                                 */
/* ------------------------------------------------------------------ */

/**
 * Serves "Caching, rate limits and realtime": reads run under the
 * service identity so many users share one cache and one rate-limit
 * budget, writes run under the caller's own identity so the Boards
 * history attributes the change to them. The identity is therefore a
 * per-call argument, never client-wide state.
 *
 * `accessToken` is a secret. It must never reach a log line.
 */
export type AdoAuth =
  | { readonly kind: 'service' }
  | {
      readonly kind: 'user';
      readonly accessToken: string;
      readonly descriptor: Descriptor;
    };

/**
 * Serves the ExpertGroup rule that every outbound call has an explicit
 * timeout. `timeoutMs` overrides the configured default for one call.
 */
export interface CallOptions {
  readonly traceId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Call options for Azure DevOps, which additionally pick the identity. */
export interface AdoCallOptions extends CallOptions {
  readonly auth: AdoAuth;
}

/**
 * Serves the spec's "Azure DevOps API surface" tables: one method per
 * listed endpoint, expressed over the raw REST 7.1 shapes in
 * `./ado/types.js`. Implementations validate every response with the
 * matching Zod schema before returning it.
 */
export interface AdoClient {
  /** GET /_apis/projects */
  listProjects(options: AdoCallOptions): Promise<AdoTeamProjectReference[]>;

  /** GET /_apis/projects/{projectId}/teams */
  listTeams(
    projectId: string,
    options: AdoCallOptions,
  ): Promise<AdoWebApiTeam[]>;

  /** GET /{project}/{team}/_apis/work/teamsettings/teamfieldvalues */
  getTeamFieldValues(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamFieldValues>;

  /**
   * GET /{project}/{team}/_apis/work/teamsettings/iterations
   * `timeframe` null lists every iteration the team subscribes to.
   */
  listTeamIterations(
    projectId: string,
    teamId: string,
    timeframe: AdoIterationTimeframe | null,
    options: AdoCallOptions,
  ): Promise<AdoTeamSettingsIteration[]>;

  /** GET .../teamsettings/iterations/{iterationId}/workitems */
  getIterationWorkItems(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoIterationWorkItems>;

  /** GET /{project}/{team}/_apis/work/boards */
  listBoards(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoBoardReference[]>;

  /** GET /{project}/{team}/_apis/work/boards/{boardId} */
  getBoard(
    projectId: string,
    teamId: string,
    boardId: string,
    options: AdoCallOptions,
  ): Promise<AdoBoard>;

  /** GET /{project}/{team}/_apis/work/taskboardcolumns */
  getTaskboardColumns(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoTaskboardColumns>;

  /** GET .../teamsettings/iterations/{iterationId}/capacities */
  getTeamCapacities(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamMemberCapacity[]>;

  /** GET .../teamsettings/iterations/{iterationId}/teamdaysoff */
  getTeamDaysOff(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamSettingsDaysOff>;

  /** POST /_apis/wit/workitemsbatch — at most 200 ids per call. */
  getWorkItemsBatch(
    request: AdoWorkItemBatchRequest,
    options: AdoCallOptions,
  ): Promise<AdoWorkItem[]>;

  /**
   * POST /_apis/wit/wiql — cross-project fallback, used only when a
   * board has no iteration subscription. `projectId` null queries the
   * whole organization.
   */
  queryWiql(
    request: AdoWiqlRequest,
    projectId: string | null,
    options: AdoCallOptions,
  ): Promise<AdoWiqlResult>;

  /**
   * PATCH /_apis/wit/workitems/{id} with a JSON Patch document. The
   * document carries the `test` op on `/rev` for optimistic concurrency,
   * the `WEF_<boardId>_Kanban.Column` write, its `.Done` companion for
   * split columns, and `System.State` when the mapping sets one.
   * Requires `auth.kind === 'user'`.
   */
  updateWorkItem(
    workItemId: number,
    patch: AdoJsonPatchDocument,
    options: AdoCallOptions,
  ): Promise<AdoWorkItem>;

  /**
   * PATCH /{project}/{team}/_apis/work/taskboardworkitems
   * /{iterationId}/{workItemId}. Moves the card only; it does not change
   * `System.State`. Requires `auth.kind === 'user'`.
   */
  updateTaskboardWorkItem(
    projectId: string,
    teamId: string,
    iterationId: string,
    workItemId: number,
    update: AdoTaskboardWorkItemUpdate,
    options: AdoCallOptions,
  ): Promise<void>;

  /** POST /_apis/hooks/subscriptions — one per project, on updates. */
  createSubscription(
    request: AdoSubscriptionRequest,
    options: AdoCallOptions,
  ): Promise<AdoSubscription>;

  /**
   * The throttling headers seen on the most recent response for that
   * identity, or null before the first call. The sync worker backs off
   * on this so the interactive path keeps its budget.
   */
  rateLimitState(auth: AdoAuth): AdoRateLimitState | null;
}

/* ------------------------------------------------------------------ */
/* Config store                                                        */
/* ------------------------------------------------------------------ */

/**
 * Serves "Domain model and column mapping" plus the audit rule in
 * "Write path". Backed by Postgres, which holds configuration and the
 * audit log and no work item content.
 */
export interface AuditQuery {
  readonly workItemId?: number;
  readonly actor?: Descriptor;
  /** ISO-8601 instants, inclusive. */
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/** A board definition before an id is assigned. */
export type NewBoardDefinition = Omit<BoardDefinition, 'id'>;

/** The fields of a board definition an admin may change. */
export type BoardDefinitionPatch = Partial<
  Pick<BoardDefinition, 'name' | 'defaultGrouping' | 'ownerDescriptor'>
>;

export interface ConfigStore {
  listBoardDefinitions(
    orgId: string,
    options: CallOptions,
  ): Promise<BoardDefinition[]>;
  getBoardDefinition(
    boardId: string,
    options: CallOptions,
  ): Promise<BoardDefinition | null>;
  createBoardDefinition(
    definition: NewBoardDefinition,
    options: CallOptions,
  ): Promise<BoardDefinition>;
  updateBoardDefinition(
    boardId: string,
    patch: BoardDefinitionPatch,
    options: CallOptions,
  ): Promise<BoardDefinition>;
  deleteBoardDefinition(boardId: string, options: CallOptions): Promise<void>;

  listBoardSources(
    boardId: string,
    options: CallOptions,
  ): Promise<BoardSource[]>;
  /** Replaces the whole source set for a board, in one transaction. */
  replaceBoardSources(
    boardId: string,
    sources: readonly BoardSource[],
    options: CallOptions,
  ): Promise<BoardSource[]>;

  listCanonicalColumns(
    boardId: string,
    options: CallOptions,
  ): Promise<CanonicalColumn[]>;
  /** Replaces the whole column set, so `order` stays contiguous. */
  replaceCanonicalColumns(
    boardId: string,
    columns: readonly CanonicalColumn[],
    options: CallOptions,
  ): Promise<CanonicalColumn[]>;

  listColumnMappings(
    boardId: string,
    options: CallOptions,
  ): Promise<ColumnMapping[]>;
  /**
   * Replaces the whole mapping table for a board, in one transaction.
   * The mapping screen edits a matrix and saves it whole; doing that as
   * N upserts plus M deletes would leave a half-mapped board visible to
   * everyone else if the tab closed in the middle.
   */
  replaceColumnMappings(
    boardId: string,
    mappings: readonly ColumnMapping[],
    options: CallOptions,
  ): Promise<ColumnMapping[]>;
  /** Keyed on (boardId, teamId, sourceColumnId). */
  upsertColumnMapping(
    mapping: ColumnMapping,
    options: CallOptions,
  ): Promise<ColumnMapping>;
  deleteColumnMapping(
    boardId: string,
    teamId: string,
    sourceColumnId: string,
    options: CallOptions,
  ): Promise<void>;

  listPersonOverrides(
    boardId: string,
    options: CallOptions,
  ): Promise<PersonOverride[]>;
  /** Replaces the whole override set for a board, in one transaction. */
  replacePersonOverrides(
    boardId: string,
    overrides: readonly PersonOverride[],
    options: CallOptions,
  ): Promise<PersonOverride[]>;
  /** Keyed on (boardId, descriptor). */
  upsertPersonOverride(
    override: PersonOverride,
    options: CallOptions,
  ): Promise<PersonOverride>;
  deletePersonOverride(
    boardId: string,
    descriptor: Descriptor,
    options: CallOptions,
  ): Promise<void>;

  /**
   * Every write attempt, success or failure. Appending must not be
   * skipped when the Azure DevOps call fails — that is the row support
   * will ask for.
   */
  appendAudit(entry: NewAuditEntry, options: CallOptions): Promise<AuditEntry>;
  listAudit(
    boardId: string,
    query: AuditQuery,
    options: CallOptions,
  ): Promise<AuditEntry[]>;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * Serves the TTL table in "Caching, rate limits and realtime". One class
 * per row, so a TTL is chosen by naming the entry kind rather than by
 * writing a number at the call site. `column-mapping` never expires; it
 * is invalidated by the admin screen.
 */
export type CacheTtlClass =
  | 'projects-teams'
  | 'team-metadata'
  | 'board-columns'
  | 'capacity'
  | 'board-snapshot'
  | 'column-mapping'
  | 'acl';

export interface CacheStore {
  /**
   * False when Redis is unreachable. Callers degrade to a live fan-out
   * and mark the snapshot `cache.degraded` rather than failing.
   */
  readonly healthy: boolean;

  /**
   * Reads and validates. A value that fails `schema` is treated as a
   * miss and deleted, so a stale shape can never poison a response.
   */
  get<T>(
    key: string,
    schema: ZodType<T>,
    options: CallOptions,
  ): Promise<T | null>;

  set<T>(
    key: string,
    value: T,
    ttl: CacheTtlClass,
    options: CallOptions,
  ): Promise<void>;

  delete(key: string, options: CallOptions): Promise<void>;

  /**
   * Invalidates by key pattern, e.g. `board:{id}:snapshot:*` after a
   * `workitem.updated` hook. Returns how many keys were removed.
   */
  invalidatePattern(pattern: string, options: CallOptions): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

/**
 * Serves "Realtime" in "Caching, rate limits and realtime": a delta is
 * pushed to every board open on that channel, so two people dragging
 * cards see each other.
 */
export interface RealtimePublisher {
  /** Channel name for a board. Deterministic, so the hub can subscribe. */
  channelFor(boardId: string): string;
  publish(envelope: RealtimeEnvelope, options: CallOptions): Promise<void>;
  /** Open connections on that channel; zero means nobody is listening. */
  subscriberCount(boardId: string): number;
}

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

/**
 * Serves "Security trimming": because reads run under a service
 * identity, trimming is ours to do. Resolved once per session and cached
 * for 15 minutes keyed by identity.
 *
 * `accessToken` is a secret. It must never reach a log line.
 */
export interface CallerIdentity {
  readonly descriptor: Descriptor;
  readonly id: string;
  readonly accessToken: string;
}

export interface CallerAcl {
  readonly descriptor: Descriptor;
  readonly readableProjectIds: readonly string[];
  readonly writableProjectIds: readonly string[];
  /** Area paths, as `Project\\Area\\Sub`. Children are implied. */
  readonly readableAreaPaths: readonly string[];
  readonly writableAreaPaths: readonly string[];
  readonly resolvedAt: Date;
  readonly expiresAt: Date;
}

export interface AclResolver {
  resolve(identity: CallerIdentity, options: CallOptions): Promise<CallerAcl>;
  /** Drops the cached ACL for one identity, e.g. after a 403. */
  invalidate(descriptor: Descriptor, options: CallOptions): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * The set of ports every request handler and worker is given. Assembled
 * once at startup; every test builds it from fakes.
 */
export interface Ports {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ado: AdoClient;
  readonly config: ConfigStore;
  readonly cache: CacheStore;
  readonly realtime: RealtimePublisher;
  readonly acl: AclResolver;
}

/** Per-request context threaded through the read and write paths. */
export interface RequestContext {
  readonly traceId: string;
  readonly logger: Logger;
  readonly identity: CallerIdentity;
  readonly grouping: BoardGrouping | null;
  readonly signal: AbortSignal;
}
