/**
 * Fakes for the HTTP tests.
 *
 * Every one of them implements a port from `ports.ts`, so the app under
 * test is the real app: the real routes, the real services, the real
 * domain and the real trimming — with Azure DevOps, Postgres and Redis
 * replaced. Redis is the one exception, and only because the cache
 * module ships an in-memory `FakeRedis`: using it means the tests
 * exercise the real `CacheStore`, TTL classes and all.
 */
import type {
  AuditEntry,
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  Descriptor,
  NewAuditEntry,
  PersonOverride,
  RealtimeEnvelope,
} from '@eg/shared';
import type {
  AdoBoard,
  AdoBoardReference,
  AdoDateRange,
  AdoIterationTimeframe,
  AdoIterationWorkItems,
  AdoJsonPatchDocument,
  AdoRateLimitState,
  AdoSubscription,
  AdoTaskboardColumns,
  AdoTeamFieldValues,
  AdoTeamMemberCapacity,
  AdoTeamProjectReference,
  AdoTeamSettingsDaysOff,
  AdoTeamSettingsIteration,
  AdoWebApiTeam,
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemBatchRequest,
} from '../ado/types.js';
import type { PublishDeltaInput, WebhookAuth } from '../realtime/index.js';
import type {
  AclResolver,
  AdoAuth,
  AdoCallOptions,
  AdoClient,
  AuditQuery,
  BoardDefinitionPatch,
  CallerAcl,
  CallerIdentity,
  CallOptions,
  Clock,
  ConfigStore,
  NewBoardDefinition,
} from '../ports.js';
import type { FastifyInstance } from 'fastify';
import type { TokenVerifier, VerifiedToken } from '../auth/token.js';
import { TokenRejectedError } from '../auth/token.js';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import type { AppContainer } from '../container.js';
import { createContainer } from '../container.js';
import type { RedisCacheStore } from '../cache/index.js';
import { createRedisCache } from '../cache/index.js';
import { FakeRedis } from '../cache/test-support.js';
import {
  BOARD_ID,
  makeAdoBoard,
  makeCanonicalColumns,
  makeCapacity,
  makeDefinition,
  makeIteration,
  makeMapping,
  makeWorkItem,
} from '../domain/test-support.js';
import { NotFoundError } from '../errors.js';
import { RecordingLogger } from '../realtime/test-support.js';

export const TEST_ORG_ID = 'org-expertgroup';
export const TEST_DESCRIPTOR = 'aad.reader';
export const OWNER_DESCRIPTOR = 'aad.owner';

export const testClock = (iso = '2026-09-17T09:00:00.000Z'): Clock => {
  const instant = new Date(iso);
  return { now: () => new Date(instant.getTime()) };
};

/* ------------------------------------------------------------------ */
/* Azure DevOps                                                        */
/* ------------------------------------------------------------------ */

export interface FakeTeamData {
  readonly projectId: string;
  readonly projectName: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly adoBoardId: string;
  readonly board: AdoBoard;
  readonly areaPaths: readonly { value: string; includeChildren: boolean }[];
  readonly iterations: readonly AdoTeamSettingsIteration[];
  readonly workItemsByIteration: Readonly<Record<string, readonly number[]>>;
  readonly capacities?: readonly AdoTeamMemberCapacity[];
  readonly daysOff?: readonly AdoDateRange[];
}

export interface RecordedUpdate {
  readonly workItemId: number;
  readonly patch: AdoJsonPatchDocument;
  readonly auth: AdoAuth;
}

const unsupported = (method: string): never => {
  throw new Error(`FakeAdoClient.${method} is not used by these tests`);
};

export class FakeAdoClient implements AdoClient {
  teams: FakeTeamData[] = [];
  readonly workItems = new Map<number, AdoWorkItem>();
  readonly calls: string[] = [];
  readonly updates: RecordedUpdate[] = [];
  /** Thrown by `updateWorkItem`, to drive the failure table. */
  updateFailure: Error | null = null;

  get callCount(): number {
    return this.calls.length;
  }

  count(method: string): number {
    return this.calls.filter((call) => call === method).length;
  }

  #team(teamId: string): FakeTeamData {
    const team = this.teams.find((entry) => entry.teamId === teamId);
    if (team === undefined) throw new NotFoundError(`no team ${teamId}`);
    return team;
  }

  async listProjects(
    _options: AdoCallOptions,
  ): Promise<AdoTeamProjectReference[]> {
    this.calls.push('listProjects');
    const seen = new Map<string, AdoTeamProjectReference>();
    for (const team of this.teams) {
      seen.set(team.projectId, { id: team.projectId, name: team.projectName });
    }
    return [...seen.values()];
  }

  async listTeams(
    projectId: string,
    _options: AdoCallOptions,
  ): Promise<AdoWebApiTeam[]> {
    this.calls.push('listTeams');
    return this.teams
      .filter((team) => team.projectId === projectId)
      .map((team) => ({ id: team.teamId, name: team.teamName }));
  }

  async getTeamFieldValues(
    _projectId: string,
    teamId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTeamFieldValues> {
    this.calls.push('getTeamFieldValues');
    const team = this.#team(teamId);
    return {
      field: { referenceName: 'System.AreaPath' },
      defaultValue: team.areaPaths[0]?.value ?? team.projectId,
      values: team.areaPaths.map((entry) => ({ ...entry })),
    };
  }

  async listTeamIterations(
    _projectId: string,
    teamId: string,
    timeframe: AdoIterationTimeframe | null,
    _options: AdoCallOptions,
  ): Promise<AdoTeamSettingsIteration[]> {
    this.calls.push('listTeamIterations');
    const iterations = this.#team(teamId).iterations;
    if (timeframe === null) return [...iterations];
    return iterations.filter(
      (iteration) => iteration.attributes?.timeFrame === timeframe,
    );
  }

  async getIterationWorkItems(
    _projectId: string,
    teamId: string,
    iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoIterationWorkItems> {
    this.calls.push('getIterationWorkItems');
    const ids = this.#team(teamId).workItemsByIteration[iterationId] ?? [];
    return {
      workItemRelations: ids.map((id) => ({
        rel: null,
        source: null,
        target: { id },
      })),
    };
  }

  async listBoards(
    _projectId: string,
    teamId: string,
    _options: AdoCallOptions,
  ): Promise<AdoBoardReference[]> {
    this.calls.push('listBoards');
    const team = this.#team(teamId);
    return [{ id: team.adoBoardId, name: 'Stories' }];
  }

  async getBoard(
    _projectId: string,
    teamId: string,
    _boardId: string,
    _options: AdoCallOptions,
  ): Promise<AdoBoard> {
    this.calls.push('getBoard');
    return this.#team(teamId).board;
  }

  async getTaskboardColumns(): Promise<AdoTaskboardColumns> {
    return unsupported('getTaskboardColumns');
  }

  async getTeamCapacities(
    _projectId: string,
    teamId: string,
    _iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTeamMemberCapacity[]> {
    this.calls.push('getTeamCapacities');
    return [...(this.#team(teamId).capacities ?? [])];
  }

  async getTeamDaysOff(
    _projectId: string,
    teamId: string,
    _iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTeamSettingsDaysOff> {
    this.calls.push('getTeamDaysOff');
    return { daysOff: [...(this.#team(teamId).daysOff ?? [])] };
  }

  async getWorkItemsBatch(
    request: AdoWorkItemBatchRequest,
    _options: AdoCallOptions,
  ): Promise<AdoWorkItem[]> {
    this.calls.push('getWorkItemsBatch');
    const found: AdoWorkItem[] = [];
    for (const id of request.ids) {
      const item = this.workItems.get(id);
      if (item !== undefined) found.push(item);
    }
    return found;
  }

  async queryWiql(): Promise<AdoWiqlResult> {
    return unsupported('queryWiql');
  }

  async updateWorkItem(
    workItemId: number,
    patch: AdoJsonPatchDocument,
    options: AdoCallOptions,
  ): Promise<AdoWorkItem> {
    this.calls.push('updateWorkItem');
    this.updates.push({ workItemId, patch, auth: options.auth });
    if (this.updateFailure !== null) throw this.updateFailure;

    const current = this.workItems.get(workItemId);
    if (current === undefined) {
      throw new NotFoundError(`no work item ${workItemId}`);
    }
    const fields = { ...current.fields };
    for (const operation of patch) {
      if (operation.op === 'test') continue;
      if (!operation.path.startsWith('/fields/')) continue;
      fields[operation.path.slice('/fields/'.length)] = operation.value;
    }
    const updated: AdoWorkItem = {
      ...current,
      rev: current.rev + 1,
      fields,
    };
    this.workItems.set(workItemId, updated);
    return updated;
  }

  async updateTaskboardWorkItem(): Promise<void> {
    return unsupported('updateTaskboardWorkItem');
  }

  async createSubscription(): Promise<AdoSubscription> {
    return unsupported('createSubscription');
  }

  rateLimitState(_auth: AdoAuth): AdoRateLimitState | null {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Config store                                                        */
/* ------------------------------------------------------------------ */

export class FakeConfigStore implements ConfigStore {
  definitions: BoardDefinition[] = [];
  sources: BoardSource[] = [];
  columns: CanonicalColumn[] = [];
  mappings: ColumnMapping[] = [];
  overrides: PersonOverride[] = [];
  readonly audits: AuditEntry[] = [];
  /** Thrown by `appendAudit`, to prove a move survives a broken audit. */
  auditFailure: Error | null = null;
  /** Thrown by `listBoardDefinitions`, to drive the readiness probe. */
  listFailure: Error | null = null;
  #nextAuditId = 1;

  async listBoardDefinitions(orgId: string): Promise<BoardDefinition[]> {
    if (this.listFailure !== null) throw this.listFailure;
    return this.definitions.filter((entry) => entry.orgId === orgId);
  }

  async getBoardDefinition(boardId: string): Promise<BoardDefinition | null> {
    return this.definitions.find((entry) => entry.id === boardId) ?? null;
  }

  async createBoardDefinition(
    definition: NewBoardDefinition,
  ): Promise<BoardDefinition> {
    const created: BoardDefinition = {
      id: `board-${this.definitions.length + 1}`,
      ...definition,
    };
    this.definitions.push(created);
    return created;
  }

  async updateBoardDefinition(
    boardId: string,
    patch: BoardDefinitionPatch,
  ): Promise<BoardDefinition> {
    const index = this.definitions.findIndex((entry) => entry.id === boardId);
    const current = this.definitions[index];
    if (current === undefined) throw new NotFoundError(`no board ${boardId}`);
    const updated = { ...current, ...patch };
    this.definitions[index] = updated;
    return updated;
  }

  async deleteBoardDefinition(boardId: string): Promise<void> {
    this.definitions = this.definitions.filter((e) => e.id !== boardId);
  }

  async listBoardSources(boardId: string): Promise<BoardSource[]> {
    return this.sources.filter((entry) => entry.boardId === boardId);
  }

  async replaceBoardSources(
    boardId: string,
    sources: readonly BoardSource[],
  ): Promise<BoardSource[]> {
    this.sources = [
      ...this.sources.filter((entry) => entry.boardId !== boardId),
      ...sources,
    ];
    return [...sources];
  }

  async listCanonicalColumns(boardId: string): Promise<CanonicalColumn[]> {
    return this.columns.filter((entry) => entry.boardId === boardId);
  }

  async replaceCanonicalColumns(
    boardId: string,
    columns: readonly CanonicalColumn[],
  ): Promise<CanonicalColumn[]> {
    this.columns = [
      ...this.columns.filter((entry) => entry.boardId !== boardId),
      ...columns,
    ];
    return [...columns];
  }

  async listColumnMappings(boardId: string): Promise<ColumnMapping[]> {
    return this.mappings.filter((entry) => entry.boardId === boardId);
  }

  async upsertColumnMapping(mapping: ColumnMapping): Promise<ColumnMapping> {
    this.mappings = this.mappings.filter(
      (entry) =>
        !(
          entry.boardId === mapping.boardId &&
          entry.teamId === mapping.teamId &&
          entry.sourceColumnId === mapping.sourceColumnId
        ),
    );
    this.mappings.push(mapping);
    return mapping;
  }

  async deleteColumnMapping(
    boardId: string,
    teamId: string,
    sourceColumnId: string,
  ): Promise<void> {
    this.mappings = this.mappings.filter(
      (entry) =>
        !(
          entry.boardId === boardId &&
          entry.teamId === teamId &&
          entry.sourceColumnId === sourceColumnId
        ),
    );
  }

  async listPersonOverrides(boardId: string): Promise<PersonOverride[]> {
    return this.overrides.filter((entry) => entry.boardId === boardId);
  }

  async upsertPersonOverride(
    override: PersonOverride,
  ): Promise<PersonOverride> {
    this.overrides.push(override);
    return override;
  }

  async deletePersonOverride(
    boardId: string,
    descriptor: Descriptor,
  ): Promise<void> {
    this.overrides = this.overrides.filter(
      (entry) =>
        !(entry.boardId === boardId && entry.descriptor === descriptor),
    );
  }

  async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
    if (this.auditFailure !== null) throw this.auditFailure;
    const stored: AuditEntry = { id: `audit-${this.#nextAuditId++}`, ...entry };
    this.audits.push(stored);
    return stored;
  }

  async listAudit(boardId: string, query: AuditQuery): Promise<AuditEntry[]> {
    return this.audits
      .filter((entry) => entry.boardId === boardId)
      .filter(
        (entry) =>
          query.workItemId === undefined ||
          entry.workItemId === query.workItemId,
      );
  }
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const makeAcl = (overrides: Partial<CallerAcl> = {}): CallerAcl => ({
  descriptor: TEST_DESCRIPTOR,
  readableProjectIds: ['Delivery', 'Data'],
  writableProjectIds: ['Delivery', 'Data'],
  readableAreaPaths: [],
  writableAreaPaths: [],
  resolvedAt: new Date('2026-09-17T09:00:00.000Z'),
  expiresAt: new Date('2026-09-17T09:15:00.000Z'),
  ...overrides,
});

export class FakeAclResolver implements AclResolver {
  acl: CallerAcl = makeAcl();
  failure: Error | null = null;
  readonly invalidated: Descriptor[] = [];

  async resolve(
    identity: CallerIdentity,
    _options: CallOptions,
  ): Promise<CallerAcl> {
    if (this.failure !== null) throw this.failure;
    return { ...this.acl, descriptor: identity.descriptor };
  }

  async invalidate(descriptor: Descriptor): Promise<void> {
    this.invalidated.push(descriptor);
  }
}

/** Maps a bearer token straight to a descriptor. No crypto in these tests. */
export class FakeTokenVerifier implements TokenVerifier {
  readonly tokens = new Map<string, string>([
    ['reader-token', TEST_DESCRIPTOR],
    ['owner-token', OWNER_DESCRIPTOR],
  ]);

  async verify(token: string): Promise<VerifiedToken> {
    const descriptor = this.tokens.get(token);
    if (descriptor === undefined) throw new TokenRejectedError('bad-signature');
    return {
      descriptor,
      id: `id-${descriptor}`,
      expiresAt: new Date('2026-09-17T10:00:00.000Z'),
      issuedAt: new Date('2026-09-17T09:00:00.000Z'),
      scopes: ['vso.work_write'],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

export class FakePublisher {
  readonly published: RealtimeEnvelope[] = [];
  #sequence = 0;

  channelFor(boardId: string): string {
    return `board:${boardId}`;
  }

  subscriberCount(): number {
    return 1;
  }

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    this.published.push(envelope);
  }

  async publishDelta(
    input: PublishDeltaInput,
    options: CallOptions,
  ): Promise<RealtimeEnvelope> {
    this.#sequence += 1;
    const envelope: RealtimeEnvelope = {
      v: 1,
      boardId: input.boardId,
      channel: this.channelFor(input.boardId),
      sequence: this.#sequence,
      emittedAt: '2026-09-17T09:00:00.000Z',
      traceId: options.traceId,
      origin: input.origin,
      delta: input.delta,
    };
    this.published.push(envelope);
    return envelope;
  }
}

/* ------------------------------------------------------------------ */
/* The app under test                                                  */
/* ------------------------------------------------------------------ */

/** Environment that parses, with no real host behind any of it. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  ADO_ORG_URL: 'https://dev.azure.com/expertgroup',
  ADO_SERVICE_TOKEN: 'service-token-value',
  REDIS_URL: 'redis://redis.invalid:6379',
  DATABASE_URL: 'postgres://postgres.invalid:5432/board',
  LOG_LEVEL: 'warn',
};

export interface TestHarness {
  readonly app: FastifyInstance;
  readonly container: AppContainer;
  readonly ado: FakeAdoClient;
  readonly config: FakeConfigStore;
  readonly cache: RedisCacheStore;
  readonly redis: FakeRedis;
  readonly acl: FakeAclResolver;
  readonly publisher: FakePublisher;
  readonly logger: RecordingLogger;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Mount the service-hook webhook with these credentials. */
  readonly webhookAuth?: WebhookAuth | null;
}

/**
 * The real app, on fakes. Nothing here opens a socket: the container is
 * handed every port it would otherwise construct.
 */
export async function buildTestApp(
  options: TestAppOptions = {},
): Promise<TestHarness> {
  const config = parseConfig(TEST_ENV);
  const logger = new RecordingLogger();
  const clock = testClock();
  const redis = new FakeRedis();
  const cache = createRedisCache({
    client: redis,
    logger,
    commandTimeoutMs: 50,
    ttlSeconds: config.cache.ttlSeconds,
    clock,
  });
  const ado = new FakeAdoClient();
  const store = new FakeConfigStore();
  const acl = new FakeAclResolver();
  const publisher = new FakePublisher();

  const container = createContainer({
    config,
    env: TEST_ENV,
    enableSync: false,
    overrides: {
      logger,
      clock,
      ado,
      config: store,
      cache,
      acl,
      verifier: new FakeTokenVerifier(),
      realtime: publisher,
      webhookAuth: options.webhookAuth ?? null,
      orgId: TEST_ORG_ID,
    },
  });

  const app = await buildApp({ container });
  return {
    app,
    container,
    ado,
    config: store,
    cache,
    redis,
    acl,
    publisher,
    logger,
    close: async () => {
      await app.close();
      await container.shutdown('test');
    },
  };
}

/** `Authorization` header for one of the fake verifier's tokens. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/* ------------------------------------------------------------------ */
/* The board fixture                                                   */
/* ------------------------------------------------------------------ */

export const TEST_BOARD_ID = BOARD_ID;
export const DEV_BOARD = 'ado-team-dev';
export const DATA_BOARD = 'ado-team-data';

const iteration = (id: string, project: string): AdoTeamSettingsIteration =>
  makeIteration({
    id,
    name: id,
    path: `${project}\\Sprint 1`,
    start: '2026-09-14T00:00:00Z',
    finish: '2026-09-25T00:00:00Z',
    timeFrame: 'current',
  });

/**
 * Two teams in two projects, three canonical columns, one mapping row per
 * team column, and three cards. `col-done` is mapped for `team-dev` and
 * carries a target state; `col-blocked` is declared but mapped nowhere,
 * which is what the write path refuses without calling Azure DevOps.
 */
export function seedDeliveryBoard(harness: TestHarness): void {
  const { ado, config } = harness;

  ado.teams = [
    {
      projectId: 'Delivery',
      projectName: 'Delivery',
      teamId: 'team-dev',
      teamName: 'Dev',
      adoBoardId: DEV_BOARD,
      board: makeAdoBoard(DEV_BOARD, ['To do', 'Doing', 'Done']),
      areaPaths: [{ value: 'Delivery\\Web', includeChildren: true }],
      iterations: [iteration('iter-dev', 'Delivery')],
      workItemsByIteration: { 'iter-dev': [101, 102] },
      capacities: [makeCapacity({ descriptor: 'aad.ana', capacityPerDay: 6 })],
      daysOff: [],
    },
    {
      projectId: 'Data',
      projectName: 'Data and AI',
      teamId: 'team-data',
      teamName: 'Data',
      adoBoardId: DATA_BOARD,
      board: makeAdoBoard(DATA_BOARD, ['To do', 'Doing', 'Done']),
      areaPaths: [{ value: 'Data\\Platform', includeChildren: true }],
      iterations: [iteration('iter-data', 'Data')],
      workItemsByIteration: { 'iter-data': [201] },
      capacities: [],
      daysOff: [],
    },
  ];

  for (const workItem of [
    makeWorkItem({
      id: 101,
      rev: 7,
      title: 'Checkout flow',
      areaPath: 'Delivery\\Web\\Checkout',
      assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
      remainingWork: 5,
      column: 'Doing',
      adoBoardId: DEV_BOARD,
      extraFields: {
        'System.IterationId': 'iter-dev',
        'System.ChangedBy': { descriptor: 'aad.milos', displayName: 'Milos' },
        'System.ChangedDate': '2026-09-17T08:30:00Z',
      },
    }),
    makeWorkItem({
      id: 102,
      rev: 3,
      title: 'Payment retries',
      areaPath: 'Delivery\\Web',
      column: 'To do',
      adoBoardId: DEV_BOARD,
      extraFields: { 'System.IterationId': 'iter-dev' },
    }),
    makeWorkItem({
      id: 201,
      rev: 2,
      title: 'Ingestion backlog',
      areaPath: 'Data\\Platform',
      assignedTo: { descriptor: 'aad.jo', displayName: 'Jo Petrovic' },
      remainingWork: 8,
      column: 'To do',
      adoBoardId: DATA_BOARD,
      extraFields: { 'System.IterationId': 'iter-data' },
    }),
  ]) {
    ado.workItems.set(workItem.id, workItem);
  }

  config.definitions = [
    makeDefinition({ id: TEST_BOARD_ID, orgId: TEST_ORG_ID }),
  ];
  config.sources = [
    {
      boardId: TEST_BOARD_ID,
      projectId: 'Delivery',
      teamId: 'team-dev',
      backlogLevel: 'Microsoft.RequirementCategory',
    },
    {
      boardId: TEST_BOARD_ID,
      projectId: 'Data',
      teamId: 'team-data',
      backlogLevel: 'Microsoft.RequirementCategory',
    },
  ];
  config.columns = [
    ...makeCanonicalColumns(),
    {
      id: 'col-blocked',
      boardId: TEST_BOARD_ID,
      name: 'Blocked',
      order: 3,
      stateCategory: 'InProgress',
    },
  ];
  config.mappings = [
    makeMapping('team-dev', `${DEV_BOARD}-col-0`, 'col-todo'),
    makeMapping('team-dev', `${DEV_BOARD}-col-1`, 'col-doing', 'Active'),
    makeMapping('team-dev', `${DEV_BOARD}-col-2`, 'col-done', 'Closed'),
    makeMapping('team-data', `${DATA_BOARD}-col-0`, 'col-todo'),
    makeMapping('team-data', `${DATA_BOARD}-col-1`, 'col-doing'),
  ];
}
