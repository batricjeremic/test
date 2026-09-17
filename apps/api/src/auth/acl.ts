/**
 * The `AclResolver` port: what this caller may read, and what they may
 * write.
 *
 * Spec, "Security trimming": "On first request in a session the BFF
 * resolves the caller's readable projects and area paths and caches that
 * ACL for 15 minutes keyed by identity." That number is the spec's, so
 * it lives here as a named constant rather than as a literal at a call
 * site, and it is the `acl` TTL class in the cache table.
 *
 * The probe deliberately runs under the *caller's* own token, not the
 * service one. That is the whole trick: Azure DevOps already trims
 * `GET /_apis/projects` and `GET /projects/{id}/teams` to what that
 * person may see, so asking as them is both cheaper and more truthful
 * than any permission arithmetic of ours.
 *
 * Failure is closed. If the ACL cannot be resolved the error propagates
 * and the request fails; there is no path in this file that returns a
 * permissive ACL, an empty-but-valid one, or a stale one past its
 * expiry.
 */
import { descriptorSchema, isoTimestampSchema } from '@eg/shared';
import type { Descriptor } from '@eg/shared';
import { z } from 'zod';
import { cacheKeys } from '../cache/keys.js';
import { toAppError } from '../errors.js';
import type { AdoTeamProjectReference, AdoWebApiTeam } from '../ado/types.js';
import type {
  AclResolver,
  AdoCallOptions,
  AdoClient,
  CacheStore,
  CallOptions,
  CallerAcl,
  CallerIdentity,
  Clock,
  Logger,
} from '../ports.js';
import { userAuth } from './identity.js';

/** The spec's number. Do not change it here; change it in the spec. */
export const ACL_TTL_MINUTES = 15;
export const ACL_TTL_MS = ACL_TTL_MINUTES * 60_000;

/** How many projects the probe interrogates at once. */
export const DEFAULT_ACL_CONCURRENCY = 4;

/**
 * The cached form. Dates cross Redis as ISO strings, so the port's
 * `ZodType` gets a schema that describes what is actually stored, and a
 * value that no longer matches is a miss rather than a poisoned ACL.
 */
export const cachedAclSchema = z.object({
  descriptor: descriptorSchema,
  readableProjectIds: z.array(z.string()),
  writableProjectIds: z.array(z.string()),
  readableAreaPaths: z.array(z.string()),
  writableAreaPaths: z.array(z.string()),
  resolvedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

export type CachedAcl = z.infer<typeof cachedAclSchema>;

export const toCachedAcl = (acl: CallerAcl): CachedAcl => ({
  descriptor: acl.descriptor,
  readableProjectIds: [...acl.readableProjectIds],
  writableProjectIds: [...acl.writableProjectIds],
  readableAreaPaths: [...acl.readableAreaPaths],
  writableAreaPaths: [...acl.writableAreaPaths],
  resolvedAt: acl.resolvedAt.toISOString(),
  expiresAt: acl.expiresAt.toISOString(),
});

export const fromCachedAcl = (cached: CachedAcl): CallerAcl => ({
  descriptor: cached.descriptor,
  readableProjectIds: cached.readableProjectIds,
  writableProjectIds: cached.writableProjectIds,
  readableAreaPaths: cached.readableAreaPaths,
  writableAreaPaths: cached.writableAreaPaths,
  resolvedAt: new Date(cached.resolvedAt),
  expiresAt: new Date(cached.expiresAt),
});

/** What the read probe found, before write permission is decided. */
export interface ReadableScope {
  readonly projectIds: readonly string[];
  readonly areaPaths: readonly string[];
  /**
   * True when some part of the probe failed. The ACL is still usable —
   * it can only be narrower than the truth, never wider — but it is not
   * cached, so the next request tries again.
   */
  readonly partial: boolean;
}

export interface WritablePolicyInput {
  readonly identity: CallerIdentity;
  readonly readable: ReadableScope;
  readonly options: CallOptions;
}

export interface WritableScope {
  readonly projectIds: readonly string[];
  readonly areaPaths: readonly string[];
}

export type WritablePolicy = (
  input: WritablePolicyInput,
) => Promise<WritableScope>;

/**
 * The default. None of the endpoints in `AdoClient` answers "may this
 * person edit work items in this project" cheaply, so a project the
 * caller can read is offered as writable and the write itself is the
 * real gate: Azure DevOps answers 403, `mapAdoError` turns that into
 * `permission_denied`, and `AclResolver.invalidate` drops the ACL so the
 * next resolve is fresh.
 *
 * Deployments that would rather refuse first can pass `nothingWritable`
 * or `restrictWritableTo`.
 */
export const writableMirrorsReadable: WritablePolicy = async (input) => ({
  projectIds: input.readable.projectIds,
  areaPaths: input.readable.areaPaths,
});

/** Read-only board: every lane renders dimmed and nothing is draggable. */
export const nothingWritable: WritablePolicy = async () => ({
  projectIds: [],
  areaPaths: [],
});

/** Writable only where an operator has said so, intersected with reads. */
export function restrictWritableTo(
  projectIds: Iterable<string>,
): WritablePolicy {
  const allowed = new Set(projectIds);
  return async (input) => ({
    projectIds: input.readable.projectIds.filter((id) => allowed.has(id)),
    areaPaths: input.readable.areaPaths,
  });
}

export interface AclResolverDeps {
  readonly ado: AdoClient;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Namespaces the cache key; one organisation per deployment. */
  readonly orgId: string;
  readonly writablePolicy?: WritablePolicy;
  /** Explicit timeout for every probe call. */
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  /** Off for a deployment that trims on project alone. */
  readonly resolveAreaPaths?: boolean;
}

/** Runs `worker` over `items`, never more than `limit` at a time. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));

interface ProjectProbe {
  readonly projectId: string;
  readonly areaPaths: readonly string[];
  readonly partial: boolean;
}

/**
 * Caches one ACL per identity for 15 minutes, in Redis under the `acl`
 * TTL class, and de-duplicates concurrent resolutions of the same
 * identity so a cold session does not fan out twice.
 */
export class CachingAclResolver implements AclResolver {
  private readonly deps: AclResolverDeps;
  private readonly writablePolicy: WritablePolicy;
  private readonly inFlight = new Map<Descriptor, Promise<CallerAcl>>();

  constructor(deps: AclResolverDeps) {
    this.deps = deps;
    this.writablePolicy = deps.writablePolicy ?? writableMirrorsReadable;
  }

  async resolve(
    identity: CallerIdentity,
    options: CallOptions,
  ): Promise<CallerAcl> {
    const cached = await this.readCache(identity.descriptor, options);
    if (cached !== null) return cached;

    const pending = this.inFlight.get(identity.descriptor);
    if (pending !== undefined) return await pending;

    const started = this.resolveLive(identity, options).finally(() => {
      this.inFlight.delete(identity.descriptor);
    });
    this.inFlight.set(identity.descriptor, started);
    return await started;
  }

  async invalidate(
    descriptor: Descriptor,
    options: CallOptions,
  ): Promise<void> {
    this.inFlight.delete(descriptor);
    try {
      await this.deps.cache.delete(this.keyFor(descriptor), options);
    } catch (error) {
      this.logger(options).warn('acl cache invalidate failed', {
        descriptor,
        reason: toAppError(error).code,
      });
    }
  }

  private keyFor(descriptor: Descriptor): string {
    return cacheKeys.acl(this.deps.orgId, descriptor);
  }

  private logger(options: CallOptions): Logger {
    return this.deps.logger.withTraceId(options.traceId);
  }

  private callOptions(options: CallOptions): CallOptions {
    const timeoutMs = options.timeoutMs ?? this.deps.timeoutMs;
    return timeoutMs === undefined ? options : { ...options, timeoutMs };
  }

  private adoOptions(
    identity: CallerIdentity,
    options: CallOptions,
  ): AdoCallOptions {
    return { ...this.callOptions(options), auth: userAuth(identity) };
  }

  /** A miss, a stale entry or an unreachable Redis all mean "resolve". */
  private async readCache(
    descriptor: Descriptor,
    options: CallOptions,
  ): Promise<CallerAcl | null> {
    let cached: CachedAcl | null = null;
    try {
      cached = await this.deps.cache.get(
        this.keyFor(descriptor),
        cachedAclSchema,
        this.callOptions(options),
      );
    } catch (error) {
      this.logger(options).warn('acl cache read failed', {
        descriptor,
        reason: toAppError(error).code,
      });
      return null;
    }
    if (cached === null) return null;
    if (cached.descriptor !== descriptor) return null;

    const acl = fromCachedAcl(cached);
    if (acl.expiresAt.getTime() <= this.deps.clock.now().getTime()) return null;
    return acl;
  }

  private async resolveLive(
    identity: CallerIdentity,
    options: CallOptions,
  ): Promise<CallerAcl> {
    const log = this.logger(options).child({ descriptor: identity.descriptor });
    const adoOptions = this.adoOptions(identity, options);

    let projects: AdoTeamProjectReference[];
    try {
      projects = await this.deps.ado.listProjects(adoOptions);
    } catch (error) {
      // Fail closed: no ACL, no snapshot. Never a permissive default.
      const failure = toAppError(error);
      log.warn('acl probe failed', { reason: failure.code });
      throw failure;
    }

    const projectIds = sortedUnique(projects.map((project) => project.id));
    const probes =
      this.deps.resolveAreaPaths === false
        ? projectIds.map<ProjectProbe>((projectId) => ({
            projectId,
            areaPaths: [],
            partial: false,
          }))
        : await mapWithConcurrency(
            projectIds,
            this.deps.concurrency ?? DEFAULT_ACL_CONCURRENCY,
            (projectId) => this.probeProject(projectId, adoOptions, log),
          );

    const readable: ReadableScope = {
      projectIds,
      areaPaths: sortedUnique(probes.flatMap((probe) => probe.areaPaths)),
      partial: probes.some((probe) => probe.partial),
    };

    const writable = await this.writablePolicy({
      identity,
      readable,
      options: this.callOptions(options),
    });

    const resolvedAt = this.deps.clock.now();
    const acl: CallerAcl = {
      descriptor: identity.descriptor,
      readableProjectIds: readable.projectIds,
      writableProjectIds: sortedUnique(
        writable.projectIds.filter((id) => projectIds.includes(id)),
      ),
      readableAreaPaths: readable.areaPaths,
      writableAreaPaths: sortedUnique(writable.areaPaths),
      resolvedAt,
      expiresAt: new Date(resolvedAt.getTime() + ACL_TTL_MS),
    };

    log.info('acl resolved', {
      readableProjectCount: acl.readableProjectIds.length,
      writableProjectCount: acl.writableProjectIds.length,
      readableAreaPathCount: acl.readableAreaPaths.length,
      partial: readable.partial,
    });

    // A partial probe is usable but not cacheable: it may be narrower
    // than the truth, and caching it would keep cards hidden for 15
    // minutes because of one failed call.
    if (!readable.partial) await this.writeCache(acl, options);
    return acl;
  }

  private async probeProject(
    projectId: string,
    adoOptions: AdoCallOptions,
    log: Logger,
  ): Promise<ProjectProbe> {
    const areaPaths: string[] = [];
    let teams: AdoWebApiTeam[];
    try {
      teams = await this.deps.ado.listTeams(projectId, adoOptions);
    } catch (error) {
      log.warn('acl team probe failed', {
        projectId,
        reason: toAppError(error).code,
      });
      return { projectId, areaPaths, partial: true };
    }

    let partial = false;
    for (const team of teams) {
      try {
        const values = await this.deps.ado.getTeamFieldValues(
          projectId,
          team.id,
          adoOptions,
        );
        for (const entry of values.values) areaPaths.push(entry.value);
      } catch (error) {
        partial = true;
        log.warn('acl area path probe failed', {
          projectId,
          teamId: team.id,
          reason: toAppError(error).code,
        });
      }
    }
    return { projectId, areaPaths, partial };
  }

  private async writeCache(
    acl: CallerAcl,
    options: CallOptions,
  ): Promise<void> {
    try {
      await this.deps.cache.set(
        this.keyFor(acl.descriptor),
        toCachedAcl(acl),
        'acl',
        this.callOptions(options),
      );
    } catch (error) {
      // A cache that will not take the ACL costs a fan-out next time.
      // It must never cost correctness, so this is a warning, not a
      // failure of the request.
      this.logger(options).warn('acl cache write failed', {
        descriptor: acl.descriptor,
        reason: toAppError(error).code,
      });
    }
  }
}

export function createAclResolver(deps: AclResolverDeps): AclResolver {
  return new CachingAclResolver(deps);
}
