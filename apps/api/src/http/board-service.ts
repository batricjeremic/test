/**
 * `GET /api/boards/{boardId}/sprint`, in the spec's order.
 *
 * Spec, "Request flow for a board load":
 *   2. resolve the board definition from Postgres;
 *   3. read the cached snapshot — on a miss fan out to Azure DevOps,
 *      build the snapshot, write it to Redis, return it;
 * and "Auth, permissions and security": trim it to the caller before it
 * leaves the server.
 *
 * The cached entry is the *untrimmed* board, so one snapshot serves every
 * caller and trimming stays per identity. That is only safe because
 * `UntrimmedBoardSnapshot` is not a `BoardSnapshot`: the sole way to get
 * a body out of this service is `trimBoardSnapshot`, which needs an ACL.
 */
import { boardSnapshotSchema } from '@eg/shared';
import type {
  BoardDefinition,
  BoardPermissions,
  BoardSnapshot,
  BoardSnapshotQuery,
  RealtimeStatus,
} from '@eg/shared';
import { z } from 'zod';
import type { AdoIterationTimeframe, AdoWorkItem } from '../ado/types.js';
import { ADO_FIELDS, readStringField } from '../ado/types.js';
import type { TrimmedBoardSnapshot } from '../auth/trim.js';
import {
  trimBoardSnapshotWithSummary,
  untrimmedSnapshot,
} from '../auth/trim.js';
import type { CacheInvalidator } from '../cache/index.js';
import { cacheFingerprint, cacheKeys } from '../cache/index.js';
import type {
  IterationCapacity,
  IterationWorkItems,
  TeamSnapshotInput,
} from '../domain/index.js';
import {
  assembleBoardSnapshot,
  resolveTeamIterationScope,
} from '../domain/index.js';
import type { ServiceHookRegistry } from '../realtime/index.js';
import { realtimeStatusFor } from '../realtime/index.js';
import type {
  CallerAcl,
  CallOptions,
  Clock,
  Logger,
  RealtimePublisher,
} from '../ports.js';
import type { BoardContext, BoardContextDeps } from './board-context.js';
import { loadBoardContext } from './board-context.js';
import {
  readCapacities,
  readDaysOff,
  readIterationWorkItems,
  readTeamIterations,
  readWorkItems,
} from './ado-reads.js';

export interface BoardReadDeps extends BoardContextDeps {
  readonly clock: Clock;
  readonly invalidator: CacheInvalidator;
  readonly realtime: Pick<RealtimePublisher, 'channelFor'>;
  readonly hooks: Pick<ServiceHookRegistry, 'missing'>;
}

/**
 * What the snapshot cache holds: the board as built, plus each card's
 * area path, so the hot and the cold path trim identically. `BoardCard`
 * carries no area path, and an area-level ACL needs one.
 */
export interface CachedBoardSnapshot {
  readonly snapshot: BoardSnapshot;
  /** Work item id (as a JSON key) -> `System.AreaPath`. */
  readonly areaPaths: Readonly<Record<string, string>>;
}

const storedSnapshotSchema = z.object({
  snapshot: boardSnapshotSchema,
  areaPaths: z.record(z.string()),
});

/**
 * The stored shape, as a schema whose input and output agree — which is
 * what `CacheStore.get` is typed on. It validates through the shared
 * schema, so a snapshot written by an older build is rejected, deleted
 * and treated as a miss rather than served.
 */
export const cachedBoardSnapshotSchema = z.custom<CachedBoardSnapshot>(
  (value) => storedSnapshotSchema.safeParse(value).success,
  { message: 'stored board snapshot no longer matches its schema' },
);

/**
 * The snapshot key. The query decides the bytes, so it decides the key;
 * the caller's identity does not, because what is cached is untrimmed.
 */
export function snapshotFingerprint(query: BoardSnapshotQuery): string {
  return cacheFingerprint({
    alignment: query.alignment,
    grouping: query.grouping,
    filters: query.filters,
  });
}

export interface LoadSnapshotInput {
  readonly definition: BoardDefinition;
  readonly query: BoardSnapshotQuery;
  readonly options: CallOptions;
  readonly logger: Logger;
}

/** A built board, before trimming, with what the envelope needs. */
export interface UntrimmedBoardLoad {
  readonly snapshot: BoardSnapshot;
  readonly areaPaths: ReadonlyMap<number, string>;
  readonly hit: boolean;
  readonly ageSeconds: number;
}

const timeframeFor = (
  query: BoardSnapshotQuery,
): AdoIterationTimeframe | null =>
  query.alignment.mode === 'each-team-current' ? 'current' : null;

const areaPathOf = (workItem: AdoWorkItem): string | null =>
  readStringField(workItem.fields, ADO_FIELDS.areaPath);

export class BoardReadService {
  readonly #deps: BoardReadDeps;

  constructor(deps: BoardReadDeps) {
    this.#deps = deps;
  }

  /** The board's configuration and team boards, for read and write. */
  async context(
    definition: BoardDefinition,
    options: CallOptions,
  ): Promise<BoardContext> {
    return loadBoardContext(this.#deps, definition, options);
  }

  /**
   * The board load the route serves. Trimming is the last step and the
   * only way out: the return type cannot be produced without an ACL.
   */
  async load(
    input: LoadSnapshotInput,
    acl: CallerAcl,
  ): Promise<TrimmedBoardSnapshot> {
    const built = await this.loadUntrimmed(input);
    const snapshot: BoardSnapshot = {
      ...built.snapshot,
      traceId: input.options.traceId,
      cache: {
        hit: built.hit,
        ageSeconds: built.ageSeconds,
        degraded: !this.#deps.cache.healthy,
      },
      realtime: this.#realtimeStatus(built.snapshot),
    };

    const { snapshot: trimmed, summary } = trimBoardSnapshotWithSummary(
      untrimmedSnapshot(snapshot, built.areaPaths),
      acl,
    );
    input.logger.info('board snapshot served', {
      boardId: input.definition.id,
      descriptor: acl.descriptor,
      cacheHit: built.hit,
      cacheAgeSeconds: built.ageSeconds,
      cardsBefore: summary.cardsBefore,
      cardsAfter: summary.cardsAfter,
      cardsRemoved: summary.cardsRemoved,
      teamsRemoved: summary.teamsRemoved,
    });
    return trimmed;
  }

  /**
   * Cache read, then fan-out on a miss. Nothing here may be handed to a
   * caller: every card the board scope holds is in it.
   */
  async loadUntrimmed(input: LoadSnapshotInput): Promise<UntrimmedBoardLoad> {
    const key = cacheKeys.boardSnapshot(
      input.definition.id,
      snapshotFingerprint(input.query),
    );
    const cached = await this.#deps.cache.get(
      key,
      cachedBoardSnapshotSchema,
      input.options,
    );
    if (cached !== null) {
      return {
        snapshot: cached.snapshot,
        areaPaths: toAreaPathMap(cached.areaPaths),
        hit: true,
        ageSeconds: this.#ageOf(cached.snapshot.generatedAt),
      };
    }

    const built = await this.#fanOut(input);
    const value: CachedBoardSnapshot = {
      snapshot: built.snapshot,
      areaPaths: Object.fromEntries(
        [...built.areaPaths].map(([id, path]) => [String(id), path]),
      ),
    };
    await this.#deps.cache.set(key, value, 'board-snapshot', input.options);
    await this.#deps.invalidator.rememberWorkItems(
      input.definition.id,
      built.snapshot.cards.map((card) => card.workItemId),
      input.options,
    );
    return { ...built, hit: false, ageSeconds: 0 };
  }

  /**
   * The cold path: every call in the spec's "Azure DevOps API surface"
   * table, then the pure assembler. A team that cannot be read fails the
   * request rather than quietly rendering a board with a team missing.
   */
  async #fanOut(input: LoadSnapshotInput): Promise<{
    readonly snapshot: BoardSnapshot;
    readonly areaPaths: ReadonlyMap<number, string>;
  }> {
    const options = input.options;
    const context = await this.context(input.definition, options);
    const timeframe = timeframeFor(input.query);
    const areaPaths = new Map<number, string>();

    const teams: TeamSnapshotInput[] = await Promise.all(
      context.entries.map(async (entry) => {
        const { projectId, teamId } = entry.source;
        const iterations = await readTeamIterations(
          this.#deps,
          projectId,
          teamId,
          timeframe,
          options,
        );
        const scope = resolveTeamIterationScope(
          { team: entry.team, iterations },
          input.query.alignment,
          this.#deps.clock,
        );

        const workItems: IterationWorkItems[] = [];
        const capacity: IterationCapacity[] = [];
        for (const resolved of scope.iterations) {
          const iterationId = resolved.window.iterationId;
          const relations = await readIterationWorkItems(
            this.#deps,
            projectId,
            teamId,
            iterationId,
            options,
          );
          const ids = relations.workItemRelations.map(
            (relation) => relation.target.id,
          );
          const items = await readWorkItems(this.#deps, ids, options);
          for (const item of items) {
            const path = areaPathOf(item);
            if (path !== null) areaPaths.set(item.id, path);
          }
          workItems.push({ iterationId, workItems: items });
          capacity.push({
            iterationId,
            capacities: await readCapacities(
              this.#deps,
              projectId,
              teamId,
              iterationId,
              options,
            ),
            teamDaysOff: await readDaysOff(
              this.#deps,
              projectId,
              teamId,
              iterationId,
              options,
            ),
          });
        }

        return {
          team: entry.team,
          areaPaths: entry.areaPaths,
          iterations,
          workItems,
          capacity,
        };
      }),
    );

    const snapshot = assembleBoardSnapshot({
      definition: input.definition,
      query: input.query,
      canonicalColumns: context.canonicalColumns,
      mappings: context.mappings,
      overrides: context.overrides,
      teams,
      permissions: boardWidePermissions(input.definition, context.projectIds),
      cache: { hit: false, ageSeconds: 0, degraded: !this.#deps.cache.healthy },
      realtime: this.#realtimeStatusFor(
        input.definition.id,
        context.projectIds,
      ),
      traceId: options.traceId,
      clock: this.#deps.clock,
    });

    input.logger.info('board snapshot built', {
      boardId: input.definition.id,
      teamCount: teams.length,
      cardCount: snapshot.cards.length,
      unmappedColumnCount: snapshot.unmappedColumns.length,
    });
    return { snapshot, areaPaths };
  }

  #realtimeStatus(snapshot: BoardSnapshot): RealtimeStatus {
    return this.#realtimeStatusFor(snapshot.boardId, [
      ...new Set(snapshot.teams.map((team) => team.projectId)),
    ]);
  }

  #realtimeStatusFor(
    boardId: string,
    projectIds: readonly string[],
  ): RealtimeStatus {
    return realtimeStatusFor({
      channel: this.#deps.realtime.channelFor(boardId),
      projectIds,
      hooks: this.#deps.hooks,
      cacheHealthy: this.#deps.cache.healthy,
    });
  }

  #ageOf(generatedAt: string): number {
    const built = Date.parse(generatedAt);
    if (!Number.isFinite(built)) return 0;
    const age = (this.#deps.clock.now().getTime() - built) / 1_000;
    return age > 0 ? Math.floor(age) : 0;
  }
}

/**
 * The permissions the *untrimmed* snapshot carries. Deliberately board
 * wide and identity free, so one cached entry serves everyone; `trim`
 * restates them from the caller's ACL, and only the board's owner keeps
 * `canAdminister`.
 */
export function boardWidePermissions(
  definition: BoardDefinition,
  projectIds: readonly string[],
): BoardPermissions {
  return {
    descriptor: definition.ownerDescriptor,
    readableProjectIds: [...projectIds],
    writableProjectIds: [...projectIds],
    canAdminister: true,
  };
}

const toAreaPathMap = (
  stored: Readonly<Record<string, string>>,
): ReadonlyMap<number, string> => {
  const map = new Map<number, string>();
  for (const [id, path] of Object.entries(stored)) {
    const workItemId = Number(id);
    if (Number.isInteger(workItemId)) map.set(workItemId, path);
  }
  return map;
};
