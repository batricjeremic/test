/**
 * The composition root: the only file that knows which implementation
 * backs which port.
 *
 * Everything else in the service depends on `ports.ts` — `AdoClient`,
 * `ConfigStore`, `CacheStore`, `RealtimePublisher`, `AclResolver`,
 * `Logger`, `Clock` — so every module can be built and tested against a
 * fake. Here, and nowhere else, those interfaces meet undici, pg, ioredis
 * and pino.
 *
 * Construction is lazy in the sense that matters: an override replaces a
 * dependency *instead of* building the real one, so a test never opens a
 * socket to Redis or Postgres. Shutdown runs in the reverse order of the
 * dependencies: stop producing work, then stop the sockets, then drain
 * what is in flight, then close the connections.
 */
import { createAdoClient } from './ado/index.js';
import {
  ADO_RESOURCE_AUDIENCE,
  ADO_TOKEN_ISSUER,
  ADO_TOKEN_JWKS_URI,
  createAclResolver,
  createTokenVerifier,
  type TokenVerifier,
} from './auth/index.js';
import {
  createCacheInvalidator,
  createRedisCache,
  createRedisClient,
  type CacheInvalidator,
  type RedisCacheStore,
} from './cache/index.js';
import type { AppConfig, EnvSource } from './config.js';
import { createConfigStore } from './db/config-store.js';
import { createDatabase, type Database } from './db/pool.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logging.js';
import type {
  AclResolver,
  AdoClient,
  CacheStore,
  Clock,
  ConfigStore,
  Logger,
  Ports,
} from './ports.js';
import {
  ServiceHookRegistry,
  WebhookWorkQueue,
  WebSocketHub,
  webhookAuthSchema,
  type DeltaPublisher,
  type WebhookAuth,
} from './realtime/index.js';
import { createSyncBucket, SyncBudget, SyncWorker } from './sync/index.js';

/** The system clock, as the `Clock` port. Injected everywhere else. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * One Azure DevOps organisation per deployment, so the id namespaces
 * every cache key. `https://dev.azure.com/expertgroup` -> `expertgroup`.
 */
export function deriveOrgId(orgUrl: string): string {
  try {
    const url = new URL(orgUrl);
    const segment = url.pathname.split('/').filter((part) => part.length > 0);
    const last = segment[segment.length - 1];
    if (last !== undefined) return last;
    const [host] = url.hostname.split('.');
    return host ?? url.hostname;
  } catch {
    return orgUrl;
  }
}

/* ------------------------------------------------------------------ */
/* Webhook credentials                                                 */
/* ------------------------------------------------------------------ */

/**
 * Service-hook credentials. They are not in `AppConfig` because the
 * webhook is optional: a deployment without service hooks falls back to
 * polling, which the realtime status reports rather than hides.
 */
export const WEBHOOK_ENV_KEYS = [
  'WEBHOOK_BASIC_USERNAME',
  'WEBHOOK_BASIC_PASSWORD',
  'WEBHOOK_SECRET_HEADER',
  'WEBHOOK_SHARED_SECRET',
] as const;

/** Null when nothing is configured; `ConfigError` when half of it is. */
export function parseWebhookAuth(source: EnvSource): WebhookAuth | null {
  const username = source.WEBHOOK_BASIC_USERNAME;
  const password = source.WEBHOOK_BASIC_PASSWORD;
  const secret = source.WEBHOOK_SHARED_SECRET;
  const headerName = source.WEBHOOK_SECRET_HEADER;

  const candidate =
    username !== undefined || password !== undefined
      ? { kind: 'basic', username, password }
      : secret !== undefined || headerName !== undefined
        ? { kind: 'shared-secret', headerName, secret }
        : null;
  if (candidate === null) return null;

  const parsed = webhookAuthSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConfigError([
      'WEBHOOK_*: is missing or invalid (value not shown)',
    ]);
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Container                                                           */
/* ------------------------------------------------------------------ */

/** Replacements for the real implementations. Tests pass fakes here. */
export interface ContainerOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ado?: AdoClient;
  readonly config?: ConfigStore;
  readonly cache?: CacheStore;
  readonly acl?: AclResolver;
  readonly verifier?: TokenVerifier;
  readonly invalidator?: CacheInvalidator;
  /** A hub replacement still has to publish deltas. */
  readonly realtime?: DeltaPublisher & Ports['realtime'];
  readonly webhookAuth?: WebhookAuth | null;
  readonly orgId?: string;
}

export interface ContainerOptions {
  readonly config: AppConfig;
  readonly env?: EnvSource;
  readonly overrides?: ContainerOverrides;
  /** The sync worker is off in tests and in one-shot processes. */
  readonly enableSync?: boolean;
}

export interface AppContainer {
  readonly config: AppConfig;
  readonly orgId: string;
  readonly ports: Ports;
  readonly invalidator: CacheInvalidator;
  readonly deltas: DeltaPublisher;
  /** Null when realtime is replaced by a fake: no socket route then. */
  readonly hub: WebSocketHub | null;
  readonly hooks: ServiceHookRegistry;
  readonly verifier: TokenVerifier;
  readonly webhookAuth: WebhookAuth | null;
  readonly webhookQueue: WebhookWorkQueue;
  readonly sync: SyncWorker | null;
  /** Starts the background work: heartbeat, prefetch. Idempotent. */
  start(): void;
  /** Stops it all, in dependency order. Safe to call twice. */
  shutdown(reason?: string): Promise<void>;
}

/**
 * Builds the container. Anything the overrides supply is used as given
 * and never constructed, which is what keeps `buildApp` testable without
 * a live Redis, Postgres or Azure DevOps.
 */
export function createContainer(options: ContainerOptions): AppContainer {
  const config = options.config;
  const overrides = options.overrides ?? {};
  const env = options.env ?? {};

  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, name: 'board-api' });
  const clock = overrides.clock ?? systemClock;
  const orgId = overrides.orgId ?? deriveOrgId(config.ado.orgUrl);

  let database: Database | null = null;
  let configStore = overrides.config;
  if (configStore === undefined) {
    database = createDatabase(
      {
        url: config.postgres.url,
        requestTimeoutMs: config.postgres.requestTimeoutMs,
      },
      logger,
    );
    configStore = createConfigStore(database, logger);
  }

  let redisCache: RedisCacheStore | null = null;
  let cache = overrides.cache;
  if (cache === undefined) {
    redisCache = createRedisCache({
      client: createRedisClient(
        {
          url: config.redis.url,
          requestTimeoutMs: config.redis.requestTimeoutMs,
        },
        logger,
      ),
      logger,
      commandTimeoutMs: config.redis.requestTimeoutMs,
      ttlSeconds: config.cache.ttlSeconds,
      clock,
    });
    cache = redisCache;
  }

  // One token bucket, shared by the interactive path and the worker, so
  // the worker cannot spend the budget the board needs.
  const bucket = createSyncBucket(config.sync.rateBudgetPerMinute, clock);
  const ado =
    overrides.ado ??
    createAdoClient({
      config: config.ado,
      logger,
      clock,
      tokenBucket: bucket,
      rateBudgetPerMinute: config.sync.rateBudgetPerMinute,
    });

  const hub =
    overrides.realtime === undefined
      ? new WebSocketHub({ logger, clock })
      : null;
  const realtime = overrides.realtime ?? hub;
  if (realtime === null) throw new ConfigError(['realtime: is not configured']);

  const acl =
    overrides.acl ??
    createAclResolver({
      ado,
      cache,
      clock,
      logger,
      orgId,
      timeoutMs: config.ado.requestTimeoutMs,
    });

  const verifier =
    overrides.verifier ??
    createTokenVerifier({
      issuer: ADO_TOKEN_ISSUER,
      audience: ADO_RESOURCE_AUDIENCE,
      jwksUri: ADO_TOKEN_JWKS_URI,
      jwksTimeoutMs: config.http.requestTimeoutMs,
      clock,
    });

  const invalidator =
    overrides.invalidator ?? createCacheInvalidator(cache, logger);
  const webhookAuth =
    overrides.webhookAuth === undefined
      ? parseWebhookAuth(env)
      : overrides.webhookAuth;
  const webhookQueue = new WebhookWorkQueue(logger);
  const hooks = new ServiceHookRegistry(logger);

  const ports: Ports = {
    logger,
    clock,
    ado,
    config: configStore,
    cache,
    realtime,
    acl,
  };

  const sync =
    options.enableSync === true
      ? new SyncWorker({
          logger,
          clock,
          ado,
          cache,
          config: configStore,
          budget: new SyncBudget({ bucket, ado, clock }),
          orgId,
          concurrency: config.sync.concurrency,
          callTimeoutMs: config.ado.requestTimeoutMs,
        })
      : null;

  let stopped = false;

  return {
    config,
    orgId,
    ports,
    invalidator,
    deltas: realtime,
    hub,
    hooks,
    verifier,
    webhookAuth,
    webhookQueue,
    sync,

    start(): void {
      hub?.start();
      sync?.start();
    },

    async shutdown(reason = 'shutdown'): Promise<void> {
      if (stopped) return;
      stopped = true;
      const log = logger.child({ component: 'container' });
      // Stop making work, stop the sockets, finish what is in flight,
      // then let go of the connections.
      await sync?.stop();
      hub?.stop(reason);
      await webhookQueue.drain();
      try {
        await redisCache?.close();
      } catch (error) {
        log.warn('redis close failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      try {
        await database?.close();
      } catch (error) {
        log.warn('database close failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      log.info('container stopped', { reason });
    },
  };
}
