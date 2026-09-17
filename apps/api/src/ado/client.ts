/**
 * The `AdoClient` port, implemented against Azure DevOps REST 7.1.
 *
 * One method per row of the spec's "Azure DevOps API surface" read table
 * and per row of its write table. Four things are true of every call:
 *
 * - it carries an explicit timeout, on headers and on body;
 * - it spends a token from a shared bucket first, because reads
 *   concentrate on one service identity and that budget is shared;
 * - its throttling headers are recorded whether it succeeded or not;
 * - its body is parsed with the matching Zod schema, so a shape we do
 *   not recognise is an error rather than a silent `undefined`.
 *
 * Reads run as the service identity and writes as the calling user, per
 * "Caching, rate limits and realtime", so the Boards history attributes
 * a move to the person who made it.
 */
import { Buffer } from 'node:buffer';
import type { ZodType } from 'zod';
import type { AdoConfig } from '../config.js';
import {
  ServiceUnavailableError,
  UnauthorizedError,
  UpstreamError,
  UpstreamTimeoutError,
  mapAdoError,
  type AdoFailure,
} from '../errors.js';
import type {
  AdoAuth,
  AdoCallOptions,
  AdoClient,
  Clock,
  Logger,
} from '../ports.js';
import { RateLimitTracker, TokenBucket, identityKey } from './rate-limit.js';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  isRetryableStatus,
  type RetryPolicy,
} from './retry.js';
import {
  adoSystemClock,
  defaultSleep,
  withTimeoutSignal,
  type Sleep,
} from './time.js';
import {
  createUndiciTransport,
  isTimeoutError,
  type AdoHttpMethod,
  type AdoHttpResponse,
  type HttpTransport,
} from './transport.js';
import {
  ADO_JSON_PATCH_CONTENT_TYPE,
  ADO_WORK_ITEM_BATCH_LIMIT,
  adoBoardListSchema,
  adoBoardSchema,
  adoCapacityListSchema,
  adoIterationListSchema,
  adoIterationWorkItemsSchema,
  adoProjectListSchema,
  adoSubscriptionSchema,
  adoTaskboardColumnsSchema,
  adoTeamFieldValuesSchema,
  adoTeamListSchema,
  adoTeamSettingsDaysOffSchema,
  adoWiqlResultSchema,
  adoWorkItemBatchRequestSchema,
  adoWorkItemListSchema,
  adoWorkItemSchema,
  parseAdoRateLimitHeaders,
  type AdoBoard,
  type AdoBoardReference,
  type AdoIterationTimeframe,
  type AdoIterationWorkItems,
  type AdoJsonPatchDocument,
  type AdoRateLimitState,
  type AdoSubscription,
  type AdoSubscriptionRequest,
  type AdoTaskboardColumns,
  type AdoTaskboardWorkItemUpdate,
  type AdoTeamFieldValues,
  type AdoTeamMemberCapacity,
  type AdoTeamProjectReference,
  type AdoTeamSettingsDaysOff,
  type AdoTeamSettingsIteration,
  type AdoWebApiTeam,
  type AdoWiqlRequest,
  type AdoWiqlResult,
  type AdoWorkItem,
  type AdoWorkItemBatchRequest,
} from './types.js';

/**
 * `api-version` per endpoint family. Azure DevOps still ships several
 * Work APIs as `-preview` under 7.1, so this is a table rather than one
 * constant, and it is overridable because Microsoft promotes them
 * without warning.
 */
export const ADO_API_VERSIONS = {
  projects: '7.1',
  teams: '7.1',
  teamFieldValues: '7.1',
  iterations: '7.1',
  iterationWorkItems: '7.1',
  boards: '7.1',
  taskboardColumns: '7.1-preview.1',
  capacities: '7.1-preview.3',
  daysOff: '7.1-preview.1',
  workItemsBatch: '7.1',
  wiql: '7.1',
  workItems: '7.1',
  taskboardWorkItems: '7.1-preview.1',
  subscriptions: '7.1-preview.1',
} as const;

export type AdoApiVersions = typeof ADO_API_VERSIONS;

/** Default burst: one cold board load's worth of calls. */
export const DEFAULT_RATE_BUDGET_PER_MINUTE = 200;

export interface AdoClientDeps {
  readonly config: AdoConfig;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Inject a fake in tests; undici in production. */
  readonly transport?: HttpTransport;
  /** Share one bucket between the request path and the sync worker. */
  readonly tokenBucket?: TokenBucket;
  readonly rateBudgetPerMinute?: number;
  readonly retry?: RetryPolicy;
  readonly sleep?: Sleep;
  /** Jitter source. Injectable so the backoff tests are deterministic. */
  readonly random?: () => number;
  readonly apiVersions?: Partial<AdoApiVersions>;
}

interface SendInput {
  readonly operation: string;
  readonly method: AdoHttpMethod;
  /** Absolute path under the organization URL, already encoded. */
  readonly path: string;
  readonly apiVersion: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly json?: unknown;
  readonly contentType?: string;
  readonly options: AdoCallOptions;
}

const segment = (value: string): string => encodeURIComponent(value);

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const safeJson = (text: string): unknown => {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const retryAfterSecondsOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export class UndiciAdoClient implements AdoClient {
  readonly tokenBucket: TokenBucket;
  readonly #config: AdoConfig;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #transport: HttpTransport;
  readonly #rateLimits = new RateLimitTracker();
  readonly #retry: RetryPolicy;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #apiVersions: AdoApiVersions;

  constructor(deps: AdoClientDeps) {
    this.#config = deps.config;
    this.#clock = deps.clock ?? adoSystemClock;
    this.#logger = deps.logger.child({ component: 'ado-client' });
    this.#transport = deps.transport ?? createUndiciTransport();
    this.#retry = deps.retry ?? DEFAULT_RETRY_POLICY;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#apiVersions = { ...ADO_API_VERSIONS, ...deps.apiVersions };
    const budget = deps.rateBudgetPerMinute ?? DEFAULT_RATE_BUDGET_PER_MINUTE;
    this.tokenBucket =
      deps.tokenBucket ??
      new TokenBucket({
        capacity: budget,
        refillPerMinute: budget,
        clock: this.#clock,
        sleep: this.#sleep,
      });
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  async listProjects(
    options: AdoCallOptions,
  ): Promise<AdoTeamProjectReference[]> {
    const list = await this.#json(adoProjectListSchema, {
      operation: 'listProjects',
      method: 'GET',
      path: '/_apis/projects',
      apiVersion: this.#apiVersions.projects,
      options,
    });
    return list.value;
  }

  async listTeams(
    projectId: string,
    options: AdoCallOptions,
  ): Promise<AdoWebApiTeam[]> {
    const list = await this.#json(adoTeamListSchema, {
      operation: 'listTeams',
      method: 'GET',
      path: `/_apis/projects/${segment(projectId)}/teams`,
      apiVersion: this.#apiVersions.teams,
      options,
    });
    return list.value;
  }

  async getTeamFieldValues(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamFieldValues> {
    return this.#json(adoTeamFieldValuesSchema, {
      operation: 'getTeamFieldValues',
      method: 'GET',
      path: `${this.#teamPath(projectId, teamId)}/teamsettings/teamfieldvalues`,
      apiVersion: this.#apiVersions.teamFieldValues,
      options,
    });
  }

  async listTeamIterations(
    projectId: string,
    teamId: string,
    timeframe: AdoIterationTimeframe | null,
    options: AdoCallOptions,
  ): Promise<AdoTeamSettingsIteration[]> {
    const list = await this.#json(adoIterationListSchema, {
      operation: 'listTeamIterations',
      method: 'GET',
      path: `${this.#teamPath(projectId, teamId)}/teamsettings/iterations`,
      apiVersion: this.#apiVersions.iterations,
      query: timeframe === null ? {} : { $timeframe: timeframe },
      options,
    });
    return list.value;
  }

  async getIterationWorkItems(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoIterationWorkItems> {
    return this.#json(adoIterationWorkItemsSchema, {
      operation: 'getIterationWorkItems',
      method: 'GET',
      path: `${this.#iterationPath(projectId, teamId, iterationId)}/workitems`,
      apiVersion: this.#apiVersions.iterationWorkItems,
      options,
    });
  }

  async listBoards(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoBoardReference[]> {
    const list = await this.#json(adoBoardListSchema, {
      operation: 'listBoards',
      method: 'GET',
      path: `${this.#teamPath(projectId, teamId)}/boards`,
      apiVersion: this.#apiVersions.boards,
      options,
    });
    return list.value;
  }

  async getBoard(
    projectId: string,
    teamId: string,
    boardId: string,
    options: AdoCallOptions,
  ): Promise<AdoBoard> {
    return this.#json(adoBoardSchema, {
      operation: 'getBoard',
      method: 'GET',
      path: `${this.#teamPath(projectId, teamId)}/boards/${segment(boardId)}`,
      apiVersion: this.#apiVersions.boards,
      options,
    });
  }

  async getTaskboardColumns(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoTaskboardColumns> {
    return this.#json(adoTaskboardColumnsSchema, {
      operation: 'getTaskboardColumns',
      method: 'GET',
      path: `${this.#teamPath(projectId, teamId)}/taskboardcolumns`,
      apiVersion: this.#apiVersions.taskboardColumns,
      options,
    });
  }

  async getTeamCapacities(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamMemberCapacity[]> {
    const list = await this.#json(adoCapacityListSchema, {
      operation: 'getTeamCapacities',
      method: 'GET',
      path: `${this.#iterationPath(projectId, teamId, iterationId)}/capacities`,
      apiVersion: this.#apiVersions.capacities,
      options,
    });
    return list.value;
  }

  async getTeamDaysOff(
    projectId: string,
    teamId: string,
    iterationId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamSettingsDaysOff> {
    return this.#json(adoTeamSettingsDaysOffSchema, {
      operation: 'getTeamDaysOff',
      method: 'GET',
      path: `${this.#iterationPath(
        projectId,
        teamId,
        iterationId,
      )}/teamdaysoff`,
      apiVersion: this.#apiVersions.daysOff,
      options,
    });
  }

  /**
   * Chunked at the service's own 200-id limit and issued concurrently;
   * the token bucket, not a semaphore, is what keeps the fan-out inside
   * the shared budget. Results come back in request order.
   */
  async getWorkItemsBatch(
    request: AdoWorkItemBatchRequest,
    options: AdoCallOptions,
  ): Promise<AdoWorkItem[]> {
    if (request.ids.length === 0) return [];
    const chunks = chunk(request.ids, ADO_WORK_ITEM_BATCH_LIMIT);
    const results = await Promise.all(
      chunks.map(async (ids) => {
        const body = adoWorkItemBatchRequestSchema.parse({
          ...request,
          ids,
        });
        const list = await this.#json(adoWorkItemListSchema, {
          operation: 'getWorkItemsBatch',
          method: 'POST',
          path: '/_apis/wit/workitemsbatch',
          apiVersion: this.#apiVersions.workItemsBatch,
          json: body,
          contentType: 'application/json',
          options,
        });
        return list.value;
      }),
    );
    return results.flat();
  }

  async queryWiql(
    request: AdoWiqlRequest,
    projectId: string | null,
    options: AdoCallOptions,
  ): Promise<AdoWiqlResult> {
    const scope = projectId === null ? '' : `/${segment(projectId)}`;
    return this.#json(adoWiqlResultSchema, {
      operation: 'queryWiql',
      method: 'POST',
      path: `${scope}/_apis/wit/wiql`,
      apiVersion: this.#apiVersions.wiql,
      json: request,
      contentType: 'application/json',
      options,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  async updateWorkItem(
    workItemId: number,
    patch: AdoJsonPatchDocument,
    options: AdoCallOptions,
  ): Promise<AdoWorkItem> {
    this.#requireUser(options.auth, 'updateWorkItem');
    return this.#json(adoWorkItemSchema, {
      operation: 'updateWorkItem',
      method: 'PATCH',
      path: `/_apis/wit/workitems/${segment(String(workItemId))}`,
      apiVersion: this.#apiVersions.workItems,
      json: patch,
      contentType: ADO_JSON_PATCH_CONTENT_TYPE,
      options,
    });
  }

  async updateTaskboardWorkItem(
    projectId: string,
    teamId: string,
    iterationId: string,
    workItemId: number,
    update: AdoTaskboardWorkItemUpdate,
    options: AdoCallOptions,
  ): Promise<void> {
    this.#requireUser(options.auth, 'updateTaskboardWorkItem');
    await this.#send({
      operation: 'updateTaskboardWorkItem',
      method: 'PATCH',
      path:
        `${this.#teamPath(projectId, teamId)}/taskboardworkitems` +
        `/${segment(iterationId)}/${segment(String(workItemId))}`,
      apiVersion: this.#apiVersions.taskboardWorkItems,
      json: update,
      contentType: 'application/json',
      options,
    });
  }

  async createSubscription(
    request: AdoSubscriptionRequest,
    options: AdoCallOptions,
  ): Promise<AdoSubscription> {
    return this.#json(adoSubscriptionSchema, {
      operation: 'createSubscription',
      method: 'POST',
      path: '/_apis/hooks/subscriptions',
      apiVersion: this.#apiVersions.subscriptions,
      json: request,
      contentType: 'application/json',
      options,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Throttling budget                                                 */
  /* ---------------------------------------------------------------- */

  rateLimitState(auth: AdoAuth): AdoRateLimitState | null {
    return this.#rateLimits.state(auth);
  }

  /**
   * How long the sync worker should hold off for that identity. Not part
   * of the port: the interactive path never waits on it, it exists so a
   * background job can yield the budget before a user feels it.
   */
  rateLimitCooldownMs(auth: AdoAuth): number {
    return this.#rateLimits.cooldownMs(auth, this.#clock.now());
  }

  /* ---------------------------------------------------------------- */
  /* Plumbing                                                          */
  /* ---------------------------------------------------------------- */

  #teamPath(projectId: string, teamId: string): string {
    return `/${segment(projectId)}/${segment(teamId)}/_apis/work`;
  }

  #iterationPath(
    projectId: string,
    teamId: string,
    iterationId: string,
  ): string {
    return (
      `${this.#teamPath(projectId, teamId)}/teamsettings/iterations` +
      `/${segment(iterationId)}`
    );
  }

  #requireUser(auth: AdoAuth, operation: string): void {
    if (auth.kind !== 'user') {
      throw new UnauthorizedError(
        `${operation} must run under the caller's own identity`,
        { details: { operation } },
      );
    }
  }

  #url(input: SendInput): string {
    const params: [string, string][] = [['api-version', input.apiVersion]];
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) params.push([key, value]);
    }
    const query = params
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    return `${this.#config.orgUrl}${input.path}?${query}`;
  }

  #headers(
    auth: AdoAuth,
    contentType: string | undefined,
  ): Record<string, string> {
    const authorization =
      auth.kind === 'service'
        ? `Basic ${Buffer.from(
            `:${this.#config.serviceToken}`,
            'utf8',
          ).toString('base64')}`
        : `Bearer ${auth.accessToken}`;
    return {
      accept: 'application/json',
      authorization,
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    };
  }

  async #json<T>(schema: ZodType<T>, input: SendInput): Promise<T> {
    const response = await this.#send(input);
    const parsed = schema.safeParse(safeJson(response.body));
    if (!parsed.success) {
      throw new UpstreamError(
        `Azure DevOps returned an unexpected shape for ${input.operation}`,
        response.statusCode,
        {
          details: {
            operation: input.operation,
            issues: parsed.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join('.')}: ${issue.code}`),
          },
        },
      );
    }
    return parsed.data;
  }

  /**
   * One request, with retries. 429 and 5xx are retried up to the policy's
   * attempt count, honouring `Retry-After`; nothing else is, because
   * retrying a 4xx only spends budget the interactive path needs.
   */
  async #send(input: SendInput): Promise<AdoHttpResponse> {
    const { options } = input;
    const logger = this.#logger.withTraceId(options.traceId).child({
      operation: input.operation,
      identity: identityKey(options.auth),
    });
    const timeoutMs = options.timeoutMs ?? this.#config.requestTimeoutMs;
    const url = this.#url(input);
    const headers = this.#headers(options.auth, input.contentType);
    const body =
      input.json === undefined ? undefined : JSON.stringify(input.json);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      options.signal?.throwIfAborted();
      await this.tokenBucket.take(1, options.signal);
      const startedAt = this.#clock.now().getTime();
      let response: AdoHttpResponse;
      try {
        response = await this.#transport({
          method: input.method,
          url,
          headers,
          ...(body === undefined ? {} : { body }),
          headersTimeoutMs: timeoutMs,
          bodyTimeoutMs: timeoutMs,
          signal: withTimeoutSignal(timeoutMs, options.signal),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          logger.warn('azure devops call timed out', { timeoutMs, attempt });
          throw new UpstreamTimeoutError(
            `${input.operation} timed out after ${timeoutMs}ms`,
            timeoutMs,
            { cause: error, details: { operation: input.operation, attempt } },
          );
        }
        logger.error('azure devops call failed to complete', { attempt });
        throw new ServiceUnavailableError(
          `${input.operation} could not reach Azure DevOps`,
          null,
          { cause: error, details: { operation: input.operation, attempt } },
        );
      }

      const rateLimit = parseAdoRateLimitHeaders(
        response.headers,
        this.#clock.now(),
      );
      this.#rateLimits.record(options.auth, rateLimit);
      const durationMs = this.#clock.now().getTime() - startedAt;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        logger.debug('azure devops call succeeded', {
          status: response.statusCode,
          attempt,
          durationMs,
          rateLimitRemaining: rateLimit.remaining,
        });
        return response;
      }

      const failure: AdoFailure = {
        status: response.statusCode,
        body: safeJson(response.body),
        headers: response.headers,
        operation: input.operation,
      };
      const error = mapAdoError(failure);
      Object.assign(error.details, { attempts: attempt });

      const retryable = isRetryableStatus(response.statusCode);
      if (!retryable || attempt >= this.#retry.maxAttempts) {
        logger.warn('azure devops call rejected', {
          status: response.statusCode,
          attempt,
          durationMs,
          code: error.code,
          retryable,
          rateLimitRemaining: rateLimit.remaining,
        });
        throw error;
      }

      const delayMs = backoffDelayMs(
        attempt,
        this.#retry,
        retryAfterSecondsOf(error) ?? rateLimit.retryAfterSeconds,
        this.#random,
      );
      logger.warn('azure devops call will be retried', {
        status: response.statusCode,
        attempt,
        durationMs,
        delayMs,
        rateLimitRemaining: rateLimit.remaining,
      });
      await this.#sleep(delayMs, options.signal);
    }
  }
}

/** Builds the client. Tests pass `transport`, `sleep`, `clock`, `random`. */
export function createAdoClient(deps: AdoClientDeps): UndiciAdoClient {
  return new UndiciAdoClient(deps);
}
