/**
 * Fakes for the sync tests: an Azure DevOps client, a cache and a config
 * store that live in memory. No test in this folder needs Redis,
 * Postgres or a live organisation.
 */
import type {
  AuditEntry,
  BoardDefinition,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';
import type { ZodType } from 'zod';
import type {
  AdoBoard,
  AdoBoardReference,
  AdoIterationWorkItems,
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
} from '../ado/types.js';
import type {
  AdoClient,
  CacheStore,
  CacheTtlClass,
  CallOptions,
  Clock,
  ConfigStore,
  LogFields,
  Logger,
} from '../ports.js';

/* ------------------------------------------------------------------ */
/* Logging and time                                                    */
/* ------------------------------------------------------------------ */

export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  readonly traceId: string;
  readonly lines: LoggedLine[];
  private readonly bindings: LogFields;

  constructor(
    traceId = 'trace-sync',
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

  matching(message: string): LoggedLine[] {
    return this.lines.filter((line) => line.message === message);
  }
}

/** A clock the test moves by hand. */
export class TestClock implements Clock {
  current: Date;

  constructor(iso = '2026-09-17T06:00:00.000Z') {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/* ------------------------------------------------------------------ */
/* Azure DevOps                                                        */
/* ------------------------------------------------------------------ */

const notUsed = (name: string): never => {
  throw new Error(`FakeAdoClient.${name} is not part of the sync path`);
};

/** Records every read and can be told which ones fail. */
export class FakeAdoClient implements AdoClient {
  readonly calls: string[] = [];
  readonly failing = new Set<string>();
  rateLimit: AdoRateLimitState | null = null;
  iterations: AdoTeamSettingsIteration[] = [
    { id: 'iteration-1', name: 'Sprint 1', path: 'Project One\\Sprint 1' },
  ];
  boards: AdoBoardReference[] = [{ id: 'ado-board-1', name: 'Stories' }];

  private record(name: string): void {
    this.calls.push(name);
    if (this.failing.has(name)) throw new Error(`${name} failed`);
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  async listProjects(): Promise<AdoTeamProjectReference[]> {
    this.record('listProjects');
    return [{ id: 'project-1', name: 'Project One' }];
  }

  async listTeams(projectId: string): Promise<AdoWebApiTeam[]> {
    this.record('listTeams');
    return [{ id: 'team-1', name: 'Team One', projectId }];
  }

  async getTeamFieldValues(): Promise<AdoTeamFieldValues> {
    this.record('getTeamFieldValues');
    return {
      field: { referenceName: 'System.AreaPath' },
      defaultValue: 'Project One',
      values: [{ value: 'Project One', includeChildren: true }],
    };
  }

  async listTeamIterations(): Promise<AdoTeamSettingsIteration[]> {
    this.record('listTeamIterations');
    return this.iterations;
  }

  async getIterationWorkItems(): Promise<AdoIterationWorkItems> {
    this.record('getIterationWorkItems');
    return { workItemRelations: [] };
  }

  async listBoards(): Promise<AdoBoardReference[]> {
    this.record('listBoards');
    return this.boards;
  }

  async getBoard(): Promise<AdoBoard> {
    this.record('getBoard');
    return { id: 'ado-board-1', name: 'Stories', columns: [] };
  }

  async getTaskboardColumns(): Promise<AdoTaskboardColumns> {
    this.record('getTaskboardColumns');
    return { columns: [] };
  }

  async getTeamCapacities(): Promise<AdoTeamMemberCapacity[]> {
    this.record('getTeamCapacities');
    return [];
  }

  async getTeamDaysOff(): Promise<AdoTeamSettingsDaysOff> {
    this.record('getTeamDaysOff');
    return { daysOff: [] };
  }

  async getWorkItemsBatch(): Promise<AdoWorkItem[]> {
    return notUsed('getWorkItemsBatch');
  }

  async queryWiql(): Promise<AdoWiqlResult> {
    return notUsed('queryWiql');
  }

  async updateWorkItem(): Promise<AdoWorkItem> {
    return notUsed('updateWorkItem');
  }

  async updateTaskboardWorkItem(): Promise<void> {
    return notUsed('updateTaskboardWorkItem');
  }

  async createSubscription(): Promise<AdoSubscription> {
    return notUsed('createSubscription');
  }

  rateLimitState(): AdoRateLimitState | null {
    return this.rateLimit;
  }
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

export interface CacheEntry {
  readonly value: unknown;
  readonly ttl: CacheTtlClass;
}

export class FakeCacheStore implements CacheStore {
  healthy = true;
  readonly entries = new Map<string, CacheEntry>();

  async get<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const parsed = schema.safeParse(entry.value);
    if (!parsed.success) {
      this.entries.delete(key);
      return null;
    }
    return parsed.data;
  }

  async set<T>(key: string, value: T, ttl: CacheTtlClass): Promise<void> {
    this.entries.set(key, { value, ttl });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<number> {
    const matcher = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`,
    );
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (matcher.test(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Every key written, in insertion order. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  ttlOf(key: string): CacheTtlClass | null {
    return this.entries.get(key)?.ttl ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Config store                                                        */
/* ------------------------------------------------------------------ */

const unsupported = (name: string): never => {
  throw new Error(`FakeConfigStore.${name} is not part of the sync path`);
};

export class FakeConfigStore implements ConfigStore {
  definitions: BoardDefinition[] = [];
  sources = new Map<string, BoardSource[]>();
  readonly failingSources = new Set<string>();
  definitionsFailure: Error | null = null;

  async listBoardDefinitions(
    orgId: string,
    _options: CallOptions,
  ): Promise<BoardDefinition[]> {
    if (this.definitionsFailure !== null) throw this.definitionsFailure;
    return this.definitions.filter((definition) => definition.orgId === orgId);
  }

  async listBoardSources(
    boardId: string,
    _options: CallOptions,
  ): Promise<BoardSource[]> {
    if (this.failingSources.has(boardId)) {
      throw new Error(`sources for ${boardId} are unreadable`);
    }
    return this.sources.get(boardId) ?? [];
  }

  async getBoardDefinition(): Promise<BoardDefinition | null> {
    return unsupported('getBoardDefinition');
  }
  async createBoardDefinition(): Promise<BoardDefinition> {
    return unsupported('createBoardDefinition');
  }
  async updateBoardDefinition(): Promise<BoardDefinition> {
    return unsupported('updateBoardDefinition');
  }
  async deleteBoardDefinition(): Promise<void> {
    return unsupported('deleteBoardDefinition');
  }
  async replaceBoardSources(): Promise<BoardSource[]> {
    return unsupported('replaceBoardSources');
  }
  async listCanonicalColumns(): Promise<CanonicalColumn[]> {
    return unsupported('listCanonicalColumns');
  }
  async replaceCanonicalColumns(): Promise<CanonicalColumn[]> {
    return unsupported('replaceCanonicalColumns');
  }
  async listColumnMappings(): Promise<ColumnMapping[]> {
    return unsupported('listColumnMappings');
  }
  async upsertColumnMapping(): Promise<ColumnMapping> {
    return unsupported('upsertColumnMapping');
  }
  async deleteColumnMapping(): Promise<void> {
    return unsupported('deleteColumnMapping');
  }
  async listPersonOverrides(): Promise<PersonOverride[]> {
    return unsupported('listPersonOverrides');
  }
  async upsertPersonOverride(): Promise<PersonOverride> {
    return unsupported('upsertPersonOverride');
  }
  async deletePersonOverride(): Promise<void> {
    return unsupported('deletePersonOverride');
  }
  async appendAudit(): Promise<AuditEntry> {
    return unsupported('appendAudit');
  }
  async listAudit(): Promise<AuditEntry[]> {
    return unsupported('listAudit');
  }
}

/** A board definition with its sources, ready to hand to the worker. */
export const boardFixture = (
  id: string,
  teams: readonly { projectId: string; teamId: string }[],
): { definition: BoardDefinition; sources: BoardSource[] } => ({
  definition: {
    id,
    name: `Board ${id}`,
    orgId: 'expertgroup',
    defaultGrouping: 'person',
    ownerDescriptor: 'aad.owner',
  },
  sources: teams.map((team) => ({
    boardId: id,
    projectId: team.projectId,
    teamId: team.teamId,
    backlogLevel: 'Microsoft.RequirementCategory',
  })),
});
