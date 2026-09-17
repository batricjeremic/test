/**
 * The ioredis connection, and the narrow command surface the cache
 * store is written against.
 *
 * Two ExpertGroup rules shape the options below. Every outbound call
 * has an explicit timeout, so `commandTimeout` and `connectTimeout` are
 * always set. And nothing unbounded: `enableOfflineQueue` is false, so
 * a command issued while the socket is down fails immediately instead
 * of queueing until someone notices.
 */
import { Redis } from 'ioredis';
import type { Logger } from '../ports.js';

/**
 * The commands the cache store uses. Deliberately not `Redis`, so the
 * tests can run against an in-memory fake and never a live server.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
}

export interface RedisClientConfig {
  /** Connection string. A secret: it never reaches a log line. */
  readonly url: string;
  /** Per-command timeout, from `AppConfig.redis.requestTimeoutMs`. */
  readonly requestTimeoutMs: number;
  /** Connection attempt timeout. Defaults to the command timeout. */
  readonly connectTimeoutMs?: number;
}

/** Longest gap between reconnection attempts. */
const MAX_RECONNECT_DELAY_MS = 10_000;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
};

/**
 * Builds the shared Redis connection. The `error` handler is not
 * optional: without a listener ioredis turns a dropped socket into an
 * unhandled error and takes the process with it. The URL carries
 * credentials, so only the host is ever logged.
 */
export function createRedisClient(
  config: RedisClientConfig,
  logger: Logger,
): Redis {
  const client = new Redis(config.url, {
    commandTimeout: config.requestTimeoutMs,
    connectTimeout: config.connectTimeoutMs ?? config.requestTimeoutMs,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: (attempt: number): number =>
      Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });

  const host = hostOf(config.url);
  client.on('error', (error: unknown) => {
    logger.warn('redis connection error', {
      redisHost: host,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
  client.on('ready', () => {
    logger.info('redis connection ready', { redisHost: host });
  });

  return client;
}
