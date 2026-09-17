/**
 * Every Azure DevOps read the board load needs, behind the cache.
 *
 * Spec, "Caching, rate limits and realtime": reads run under the service
 * identity so many users share one cache and one rate-limit budget, and
 * each entry class has its own TTL. The TTL is never a number at a call
 * site — it comes from `CACHE_KEY_TTL_CLASS`, keyed by the same builder
 * that made the key, so a key and its TTL cannot drift apart.
 *
 * A cache that is down is not an error: `CacheStore` degrades to misses,
 * the read still happens, and the snapshot is marked degraded.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import type {
  AdoBoard,
  AdoBoardReference,
  AdoIterationTimeframe,
  AdoIterationWorkItems,
  AdoTeamFieldValues,
  AdoTeamMemberCapacity,
  AdoTeamProjectReference,
  AdoTeamSettingsDaysOff,
  AdoTeamSettingsIteration,
  AdoWebApiTeam,
  AdoWorkItem,
} from '../ado/types.js';
import {
  adoBoardReferenceSchema,
  adoBoardSchema,
  adoIterationWorkItemsSchema,
  adoTeamFieldValuesSchema,
  adoTeamMemberCapacitySchema,
  adoTeamProjectReferenceSchema,
  adoTeamSettingsDaysOffSchema,
  adoTeamSettingsIterationSchema,
  adoWebApiTeamSchema,
} from '../ado/types.js';
import { serviceCallOptions } from '../auth/identity.js';
import { CACHE_KEY_TTL_CLASS, cacheKeys } from '../cache/index.js';
import type { TeamScope } from '../cache/index.js';
import type {
  AdoClient,
  CacheStore,
  CacheTtlClass,
  CallOptions,
  Logger,
} from '../ports.js';

/** The ports a cached read needs, and nothing else. */
export interface AdoReadDeps {
  readonly ado: AdoClient;
  readonly cache: CacheStore;
  readonly logger: Logger;
  readonly orgId: string;
  /** Explicit per-call timeout, per the outbound-call rule. */
  readonly callTimeoutMs?: number;
}

const withTimeout = (
  options: CallOptions,
  timeoutMs: number | undefined,
): CallOptions =>
  timeoutMs === undefined ? options : { ...options, timeoutMs };

/**
 * Read through the cache: validate what is stored, call Azure DevOps on
 * a miss, write the result back under the TTL class the key declares.
 */
export async function readThrough<T>(
  deps: AdoReadDeps,
  key: string,
  ttl: CacheTtlClass,
  schema: ZodType<T>,
  load: (options: CallOptions) => Promise<T>,
  options: CallOptions,
): Promise<T> {
  const cached = await deps.cache.get(key, schema, options);
  if (cached !== null) return cached;
  const fresh = await load(withTimeout(options, deps.callTimeoutMs));
  await deps.cache.set(key, fresh, ttl, options);
  return fresh;
}

const scopeFor = (
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
): TeamScope => ({ orgId: deps.orgId, projectId, teamId });

/* ------------------------------------------------------------------ */
/* Organisation directory                                              */
/* ------------------------------------------------------------------ */

export async function readProjects(
  deps: AdoReadDeps,
  options: CallOptions,
): Promise<AdoTeamProjectReference[]> {
  return readThrough(
    deps,
    cacheKeys.projects(deps.orgId),
    CACHE_KEY_TTL_CLASS.projects,
    z.array(adoTeamProjectReferenceSchema),
    async (call) => deps.ado.listProjects(serviceCallOptions(call)),
    options,
  );
}

export async function readTeams(
  deps: AdoReadDeps,
  projectId: string,
  options: CallOptions,
): Promise<AdoWebApiTeam[]> {
  return readThrough(
    deps,
    cacheKeys.teams(deps.orgId, projectId),
    CACHE_KEY_TTL_CLASS.teams,
    z.array(adoWebApiTeamSchema),
    async (call) => deps.ado.listTeams(projectId, serviceCallOptions(call)),
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Team metadata                                                       */
/* ------------------------------------------------------------------ */

export async function readTeamFieldValues(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  options: CallOptions,
): Promise<AdoTeamFieldValues> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.teamFieldValues(scope),
    CACHE_KEY_TTL_CLASS.teamFieldValues,
    adoTeamFieldValuesSchema,
    async (call) =>
      deps.ado.getTeamFieldValues(projectId, teamId, serviceCallOptions(call)),
    options,
  );
}

export async function readTeamBoards(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  options: CallOptions,
): Promise<AdoBoardReference[]> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.teamBoards(scope),
    CACHE_KEY_TTL_CLASS.teamBoards,
    z.array(adoBoardReferenceSchema),
    async (call) =>
      deps.ado.listBoards(projectId, teamId, serviceCallOptions(call)),
    options,
  );
}

export async function readBoard(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  adoBoardId: string,
  options: CallOptions,
): Promise<AdoBoard> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.boardColumns(scope, adoBoardId),
    CACHE_KEY_TTL_CLASS.boardColumns,
    adoBoardSchema,
    async (call) =>
      deps.ado.getBoard(
        projectId,
        teamId,
        adoBoardId,
        serviceCallOptions(call),
      ),
    options,
  );
}

export async function readTeamIterations(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  timeframe: AdoIterationTimeframe | null,
  options: CallOptions,
): Promise<AdoTeamSettingsIteration[]> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.teamIterations(scope, timeframe),
    CACHE_KEY_TTL_CLASS.teamIterations,
    z.array(adoTeamSettingsIterationSchema),
    async (call) =>
      deps.ado.listTeamIterations(
        projectId,
        teamId,
        timeframe,
        serviceCallOptions(call),
      ),
    options,
  );
}

export async function readIterationWorkItems(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  iterationId: string,
  options: CallOptions,
): Promise<AdoIterationWorkItems> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.iterationWorkItems(scope, iterationId),
    CACHE_KEY_TTL_CLASS.iterationWorkItems,
    adoIterationWorkItemsSchema,
    async (call) =>
      deps.ado.getIterationWorkItems(
        projectId,
        teamId,
        iterationId,
        serviceCallOptions(call),
      ),
    options,
  );
}

export async function readCapacities(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  iterationId: string,
  options: CallOptions,
): Promise<AdoTeamMemberCapacity[]> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.capacities(scope, iterationId),
    CACHE_KEY_TTL_CLASS.capacities,
    z.array(adoTeamMemberCapacitySchema),
    async (call) =>
      deps.ado.getTeamCapacities(
        projectId,
        teamId,
        iterationId,
        serviceCallOptions(call),
      ),
    options,
  );
}

export async function readDaysOff(
  deps: AdoReadDeps,
  projectId: string,
  teamId: string,
  iterationId: string,
  options: CallOptions,
): Promise<AdoTeamSettingsDaysOff> {
  const scope = scopeFor(deps, projectId, teamId);
  return readThrough(
    deps,
    cacheKeys.daysOff(scope, iterationId),
    CACHE_KEY_TTL_CLASS.daysOff,
    adoTeamSettingsDaysOffSchema,
    async (call) =>
      deps.ado.getTeamDaysOff(
        projectId,
        teamId,
        iterationId,
        serviceCallOptions(call),
      ),
    options,
  );
}

/**
 * Card fields in bulk. Not cached: the board snapshot that holds them is
 * the cache entry, and it lives 60 seconds. The client chunks the ids at
 * the API's own batch limit; `errorPolicy: 'omit'` keeps one deleted work
 * item from failing a whole board.
 */
export async function readWorkItems(
  deps: AdoReadDeps,
  ids: readonly number[],
  options: CallOptions,
): Promise<AdoWorkItem[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  return deps.ado.getWorkItemsBatch(
    { ids: unique, errorPolicy: 'omit' },
    serviceCallOptions(withTimeout(options, deps.callTimeoutMs)),
  );
}
