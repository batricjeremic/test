/**
 * Fakes for the auth tests.
 *
 * Every port the module depends on is faked here, so nothing in this
 * folder needs a live Redis, Postgres or Azure DevOps — the ExpertGroup
 * testing rule — and nothing needs a network round trip to a JWKS
 * endpoint either: tokens are signed with a key pair generated in the
 * test process.
 */
import {
  DEFAULT_ITERATION_ALIGNMENT,
  DEFAULT_POLL_INTERVAL_SECONDS,
  EMPTY_BOARD_FILTER_SET,
  UNASSIGNED_LANE_ID,
} from '@eg/shared';
import type {
  BoardCard,
  BoardSnapshot,
  BoardSwimlane,
  BoardTeamView,
  CanonicalColumn,
  PersonLoad,
  TeamIterationWindow,
} from '@eg/shared';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey as JoseCryptoKey, JWK } from 'jose';
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
} from '../ado/types.js';
import type {
  AdoCallOptions,
  AdoClient,
  CacheStore,
  CacheTtlClass,
  CallOptions,
  CallerAcl,
  Clock,
  LogFields,
  Logger,
} from '../ports.js';

/* ------------------------------------------------------------------ */
/* Logger and clock                                                    */
/* ------------------------------------------------------------------ */

export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** Records instead of writing, so a test can assert what was logged. */
export class RecordingLogger implements Logger {
  readonly traceId: string;
  readonly lines: LoggedLine[];
  private readonly bindings: LogFields;

  constructor(
    traceId = 'trace-test',
    lines: LoggedLine[] = [],
    bindings: LogFields = {},
  ) {
    this.traceId = traceId;
    this.lines = lines;
    this.bindings = bindings;
  }

  child(bindings: LogFields): Logger {
    return new RecordingLogger(this.traceId, this.lines, {
      ...this.bindings,
      ...bindings,
    });
  }

  withTraceId(traceId: string): Logger {
    return new RecordingLogger(traceId, this.lines, this.bindings);
  }

  private write(level: string, message: string, fields?: LogFields): void {
    this.lines.push({
      level,
      message,
      fields: { ...this.bindings, ...(fields ?? {}) },
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  /** Every field value ever logged, flattened, for leak assertions. */
  everyValue(): string[] {
    return this.lines.flatMap((line) => [
      line.message,
      ...Object.values(line.fields).map((value) => JSON.stringify(value) ?? ''),
    ]);
  }
}

/** A clock the test moves by hand. */
export class TestClock implements Clock {
  private current: Date;

  constructor(iso = '2026-09-17T09:00:00.000Z') {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

export interface CacheWrite {
  readonly key: string;
  readonly value: unknown;
  readonly ttl: CacheTtlClass;
}

/** In-memory `CacheStore`. Validates on read, exactly as Redis does. */
export class FakeCacheStore implements CacheStore {
  healthy = true;
  readonly entries = new Map<string, unknown>();
  readonly writes: CacheWrite[] = [];
  readonly deletes: string[] = [];
  /** Set to make every operation throw, as an unreachable Redis does. */
  failure: Error | null = null;

  async get<T>(
    key: string,
    schema: ZodType<T>,
    _options: CallOptions,
  ): Promise<T | null> {
    if (this.failure !== null) throw this.failure;
    if (!this.entries.has(key)) return null;
    const parsed = schema.safeParse(this.entries.get(key));
    if (!parsed.success) {
      this.entries.delete(key);
      return null;
    }
    return parsed.data;
  }

  async set<T>(
    key: string,
    value: T,
    ttl: CacheTtlClass,
    _options: CallOptions,
  ): Promise<void> {
    if (this.failure !== null) throw this.failure;
    // Round-trips through JSON, so a test sees what Redis would store.
    this.entries.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    this.writes.push({ key, value, ttl });
  }

  async delete(key: string, _options: CallOptions): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.entries.delete(key);
    this.deletes.push(key);
  }

  async invalidatePattern(
    _pattern: string,
    _options: CallOptions,
  ): Promise<number> {
    if (this.failure !== null) throw this.failure;
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Azure DevOps                                                        */
/* ------------------------------------------------------------------ */

const notImplemented = (method: string): never => {
  throw new Error(`FakeAdoClient.${method} is not used by these tests`);
};

export interface FakeProject {
  readonly id: string;
  readonly teams?: readonly {
    readonly id: string;
    readonly areaPaths?: readonly string[];
  }[];
}

export interface RecordedAdoCall {
  readonly method: string;
  readonly authKind: string;
  readonly traceId: string;
  readonly timeoutMs: number | undefined;
  readonly projectId?: string;
  readonly teamId?: string;
}

/**
 * Answers the three endpoints the ACL probe uses and records how it was
 * called, including which identity it ran under — the assertion that
 * keeps read-under-service from creeping into the probe.
 */
export class FakeAdoClient implements AdoClient {
  readonly calls: RecordedAdoCall[] = [];
  projects: readonly FakeProject[] = [];
  /** Method name to the error it should throw. */
  readonly failures = new Map<string, Error>();

  constructor(projects: readonly FakeProject[] = []) {
    this.projects = projects;
  }

  private record(
    method: string,
    options: AdoCallOptions,
    extra: { projectId?: string; teamId?: string } = {},
  ): void {
    this.calls.push({
      method,
      authKind: options.auth.kind,
      traceId: options.traceId,
      timeoutMs: options.timeoutMs,
      ...extra,
    });
    const failure = this.failures.get(method);
    if (failure !== undefined) throw failure;
  }

  async listProjects(
    options: AdoCallOptions,
  ): Promise<AdoTeamProjectReference[]> {
    this.record('listProjects', options);
    return this.projects.map((project) => ({
      id: project.id,
      name: project.id,
    }));
  }

  async listTeams(
    projectId: string,
    options: AdoCallOptions,
  ): Promise<AdoWebApiTeam[]> {
    this.record('listTeams', options, { projectId });
    const project = this.projects.find((entry) => entry.id === projectId);
    return (project?.teams ?? []).map((team) => ({
      id: team.id,
      name: team.id,
    }));
  }

  async getTeamFieldValues(
    projectId: string,
    teamId: string,
    options: AdoCallOptions,
  ): Promise<AdoTeamFieldValues> {
    this.record('getTeamFieldValues', options, { projectId, teamId });
    const team = this.projects
      .find((entry) => entry.id === projectId)
      ?.teams?.find((entry) => entry.id === teamId);
    const paths = team?.areaPaths ?? [];
    return {
      field: { referenceName: 'System.AreaPath' },
      defaultValue: paths[0] ?? projectId,
      values: paths.map((value) => ({ value, includeChildren: true })),
    };
  }

  async listTeamIterations(
    _projectId: string,
    _teamId: string,
    _timeframe: AdoIterationTimeframe | null,
    _options: AdoCallOptions,
  ): Promise<AdoTeamSettingsIteration[]> {
    return notImplemented('listTeamIterations');
  }

  async getIterationWorkItems(
    _projectId: string,
    _teamId: string,
    _iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoIterationWorkItems> {
    return notImplemented('getIterationWorkItems');
  }

  async listBoards(
    _projectId: string,
    _teamId: string,
    _options: AdoCallOptions,
  ): Promise<AdoBoardReference[]> {
    return notImplemented('listBoards');
  }

  async getBoard(
    _projectId: string,
    _teamId: string,
    _boardId: string,
    _options: AdoCallOptions,
  ): Promise<AdoBoard> {
    return notImplemented('getBoard');
  }

  async getTaskboardColumns(
    _projectId: string,
    _teamId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTaskboardColumns> {
    return notImplemented('getTaskboardColumns');
  }

  async getTeamCapacities(
    _projectId: string,
    _teamId: string,
    _iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTeamMemberCapacity[]> {
    return notImplemented('getTeamCapacities');
  }

  async getTeamDaysOff(
    _projectId: string,
    _teamId: string,
    _iterationId: string,
    _options: AdoCallOptions,
  ): Promise<AdoTeamSettingsDaysOff> {
    return notImplemented('getTeamDaysOff');
  }

  async getWorkItemsBatch(
    _request: AdoWorkItemBatchRequest,
    _options: AdoCallOptions,
  ): Promise<AdoWorkItem[]> {
    return notImplemented('getWorkItemsBatch');
  }

  async queryWiql(
    _request: AdoWiqlRequest,
    _projectId: string | null,
    _options: AdoCallOptions,
  ): Promise<AdoWiqlResult> {
    return notImplemented('queryWiql');
  }

  async updateWorkItem(
    _workItemId: number,
    _patch: AdoJsonPatchDocument,
    _options: AdoCallOptions,
  ): Promise<AdoWorkItem> {
    return notImplemented('updateWorkItem');
  }

  async updateTaskboardWorkItem(
    _projectId: string,
    _teamId: string,
    _iterationId: string,
    _workItemId: number,
    _update: AdoTaskboardWorkItemUpdate,
    _options: AdoCallOptions,
  ): Promise<void> {
    return notImplemented('updateTaskboardWorkItem');
  }

  async createSubscription(
    _request: AdoSubscriptionRequest,
    _options: AdoCallOptions,
  ): Promise<AdoSubscription> {
    return notImplemented('createSubscription');
  }

  rateLimitState(): AdoRateLimitState | null {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export const TEST_ISSUER = 'https://app.vstoken.test.local';
export const TEST_AUDIENCE = 'board-api';

export interface TestKeyMaterial {
  readonly kid: string;
  readonly privateKey: JoseCryptoKey;
  readonly publicJwk: JWK;
}

export async function generateTestKey(
  kid = 'test-key-1',
): Promise<TestKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: 'RS256' } };
}

export interface TestTokenSpec {
  readonly key: TestKeyMaterial;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly descriptor?: string | null;
  readonly scopes?: string;
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
  readonly extraClaims?: Readonly<Record<string, unknown>>;
}

/** Mints a token exactly as the issuer would, for the verifier tests. */
export async function signTestToken(spec: TestTokenSpec): Promise<string> {
  const issuedAt = spec.issuedAt ?? new Date('2026-09-17T09:00:00.000Z');
  const expiresAt = spec.expiresAt ?? new Date(issuedAt.getTime() + 3_600_000);
  const claims: Record<string, unknown> = { ...(spec.extraClaims ?? {}) };
  if (spec.descriptor !== null) {
    claims['descriptor'] = spec.descriptor ?? 'aad.dGVzdC11c2Vy';
  }
  if (spec.scopes !== undefined) claims['scp'] = spec.scopes;

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: spec.key.kid })
    .setIssuer(spec.issuer ?? TEST_ISSUER)
    .setAudience(spec.audience ?? TEST_AUDIENCE)
    .setSubject(spec.subject ?? '11111111-2222-3333-4444-555555555555')
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(spec.key.privateKey);
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

export const TEST_DESCRIPTOR = 'aad.dGVzdC11c2Vy';

export function makeAcl(overrides: Partial<CallerAcl> = {}): CallerAcl {
  const resolvedAt = overrides.resolvedAt ?? new Date('2026-09-17T09:00:00Z');
  return {
    descriptor: TEST_DESCRIPTOR,
    readableProjectIds: [],
    writableProjectIds: [],
    readableAreaPaths: [],
    writableAreaPaths: [],
    resolvedAt,
    expiresAt: new Date(resolvedAt.getTime() + 15 * 60_000),
    ...overrides,
  };
}

export interface CardSpec {
  readonly workItemId: number;
  readonly project: string;
  readonly teamId?: string;
  readonly iterationId?: string;
  readonly descriptor?: string | null;
  readonly displayName?: string;
  readonly remainingWork?: number | null;
  readonly canonicalColumnId?: string;
  readonly sourceColumn?: string;
}

export function makeCard(spec: CardSpec): BoardCard {
  const descriptor = spec.descriptor === undefined ? null : spec.descriptor;
  return {
    workItemId: spec.workItemId,
    project: spec.project,
    teamId: spec.teamId ?? `${spec.project}-team`,
    iterationId: spec.iterationId ?? `${spec.project}-iteration`,
    title: `Work item ${spec.workItemId}`,
    type: 'User Story',
    assignedTo:
      descriptor === null
        ? null
        : { descriptor, displayName: spec.displayName ?? 'Someone' },
    state: 'Active',
    sourceColumn: spec.sourceColumn ?? 'Doing',
    canonicalColumnId: spec.canonicalColumnId ?? 'col-doing',
    remainingWork: spec.remainingWork === undefined ? 4 : spec.remainingWork,
    tags: [],
    rev: 3,
  };
}

const iterationWindow = (
  projectId: string,
  teamId: string,
): TeamIterationWindow => ({
  projectId,
  projectName: projectId,
  teamId,
  teamName: teamId,
  iterationId: `${projectId}-iteration`,
  iterationPath: `${projectId}\\Sprint 1`,
  iterationName: 'Sprint 1',
  startDate: '2026-09-14T00:00:00.000Z',
  finishDate: '2026-09-25T00:00:00.000Z',
  workingDaysTotal: 10,
  workingDaysElapsed: 3,
});

export function makeTeamView(
  projectId: string,
  teamId = `${projectId}-team`,
  writable = true,
): BoardTeamView {
  return {
    projectId,
    teamId,
    backlogLevel: 'Microsoft.RequirementCategory',
    iteration: iterationWindow(projectId, teamId),
    mappedCanonicalColumnIds: ['col-todo', 'col-doing'],
    writable,
  };
}

const laneFor = (card: BoardCard): string =>
  card.assignedTo === null
    ? UNASSIGNED_LANE_ID
    : `person:${card.assignedTo.descriptor}`;

/**
 * Person-grouped lanes over every card, as the untrimmed snapshot would
 * carry them: the Unassigned lane pinned first, then one per assignee.
 */
export function makeSwimlanes(cards: readonly BoardCard[]): BoardSwimlane[] {
  const order = [UNASSIGNED_LANE_ID];
  for (const card of cards) {
    const id = laneFor(card);
    if (!order.includes(id)) order.push(id);
  }
  return order.map((id, index) => {
    const own = cards.filter((card) => laneFor(card) === id);
    let hours = 0;
    let without = 0;
    for (const card of own) {
      if (card.remainingWork === null) without += 1;
      else hours += card.remainingWork;
    }
    const first = own[0];
    return {
      id,
      kind: id === UNASSIGNED_LANE_ID ? 'unassigned' : 'person',
      label:
        id === UNASSIGNED_LANE_ID
          ? 'Unassigned'
          : (first?.assignedTo?.displayName ?? id),
      personDescriptor:
        id === UNASSIGNED_LANE_ID
          ? null
          : (first?.assignedTo?.descriptor ?? null),
      teamId: null,
      order: index,
      cardCount: own.length,
      hiddenCardCount: 0,
      remainingWorkHours: hours,
      cardsWithoutRemainingWork: without,
    };
  });
}

export function makePersonLoad(
  descriptor: string,
  cards: readonly BoardCard[],
  projectIds: readonly string[],
): PersonLoad {
  const own = cards.filter(
    (card) => card.assignedTo?.descriptor === descriptor,
  );
  let committed = 0;
  let without = 0;
  for (const card of own) {
    if (card.remainingWork === null) without += 1;
    else committed += card.remainingWork;
  }
  return {
    descriptor,
    displayName: own[0]?.assignedTo?.displayName ?? descriptor,
    hidden: false,
    capacityHours: projectIds.length * 40,
    committedHours: committed,
    load: committed / Math.max(1, projectIds.length * 40),
    partialCapacity: false,
    outOfScopeTeamCount: 0,
    cardCount: own.length,
    cardsWithoutRemainingWork: without,
    perTeam: projectIds.map((projectId) => {
      const teamCards = own.filter((card) => card.project === projectId);
      let teamCommitted = 0;
      for (const card of teamCards) teamCommitted += card.remainingWork ?? 0;
      return {
        projectId,
        teamId: `${projectId}-team`,
        teamName: `${projectId}-team`,
        iterationId: `${projectId}-iteration`,
        hasCapacityRecord: true,
        capacityPerDay: 4,
        workingDays: 10,
        daysOff: 0,
        capacityHours: 40,
        committedHours: teamCommitted,
        cardCount: teamCards.length,
      };
    }),
    computedAt: '2026-09-17T09:00:00.000Z',
  };
}

const COLUMNS: CanonicalColumn[] = [
  {
    id: 'col-todo',
    boardId: 'board-delivery',
    name: 'To do',
    order: 0,
    stateCategory: 'Proposed',
  },
  {
    id: 'col-doing',
    boardId: 'board-delivery',
    name: 'Doing',
    order: 1,
    stateCategory: 'InProgress',
  },
];

export interface SnapshotSpec {
  readonly cards: readonly BoardCard[];
  readonly projectIds: readonly string[];
  readonly personLoad?: readonly PersonLoad[];
  readonly hiddenCardCount?: number;
}

/** A complete, untrimmed `BoardSnapshot`: every card, for every caller. */
export function makeSnapshot(spec: SnapshotSpec): BoardSnapshot {
  const descriptors = [
    ...new Set(
      spec.cards
        .map((card) => card.assignedTo?.descriptor)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  return {
    boardId: 'board-delivery',
    boardName: 'Delivery — all divisions',
    orgId: 'org-expertgroup',
    generatedAt: '2026-09-17T09:00:00.000Z',
    traceId: 'trace-test',
    cache: { hit: false, ageSeconds: 0, degraded: false },
    grouping: 'person',
    alignment: DEFAULT_ITERATION_ALIGNMENT,
    filters: EMPTY_BOARD_FILTER_SET,
    columns: COLUMNS,
    teams: spec.projectIds.map((projectId) => makeTeamView(projectId)),
    swimlanes: makeSwimlanes(spec.cards),
    cards: [...spec.cards],
    personLoad:
      spec.personLoad === undefined
        ? descriptors.map((descriptor) =>
            makePersonLoad(descriptor, spec.cards, spec.projectIds),
          )
        : [...spec.personLoad],
    unmappedColumns: [],
    permissions: {
      descriptor: TEST_DESCRIPTOR,
      readableProjectIds: [...spec.projectIds],
      writableProjectIds: [...spec.projectIds],
      canAdminister: false,
    },
    realtime: {
      mode: 'live',
      channel: 'board:board-delivery',
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      reason: null,
    },
    burndown: 'available',
    hiddenCardCount: spec.hiddenCardCount ?? 0,
  };
}
