/**
 * The `CacheStore` port, implemented on Redis.
 *
 * Serves the TTL table in "Caching, rate limits and realtime". Four
 * behaviours are load-bearing:
 *
 * - a TTL is chosen by naming an entry class, never by writing a number
 *   at a call site, so the spec's table lives in configuration only;
 * - every value is stored in an envelope and validated with Zod on the
 *   way out: an entry whose shape no longer matches the current code is
 *   a miss, never a crash and never stale garbage served to a user;
 * - a cache failure is never a request failure. Reads report a miss,
 *   writes become no-ops, the store reports unhealthy and the caller
 *   degrades to a live fan-out;
 * - a dead Redis costs one command timeout, not one per operation: the
 *   circuit breaker short-circuits until a probe succeeds, and the
 *   health transition is logged once rather than once per command.
 */
import type { ZodType } from 'zod';
import { DEFAULT_CACHE_TTL_SECONDS } from '../config.js';
import type {
  CacheStore,
  CacheTtlClass,
  CallOptions,
  Clock,
  Logger,
} from '../ports.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerOptions,
} from './breaker.js';
import type { RedisLike } from './client.js';

/** Envelope version. Bumped only when the envelope itself changes. */
export const CACHE_ENVELOPE_VERSION = 1;

/** A hit, with enough metadata to fill `SnapshotCacheInfo`. */
export interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: Date;
  readonly ageSeconds: number;
}

export interface RedisCacheOptions {
  readonly client: RedisLike;
  readonly logger: Logger;
  /** Per-command timeout. Overridable per call via `CallOptions`. */
  readonly commandTimeoutMs: number;
  /** Defaults to the spec's table. Zero means "no expiry". */
  readonly ttlSeconds?: Readonly<Record<CacheTtlClass, number>>;
  readonly clock?: Clock;
  readonly breaker?: CircuitBreakerOptions;
  /** Keys asked for per SCAN round trip. Default 512. */
  readonly scanCount?: number;
}

/** The store, plus the few things only its owner needs. */
export interface RedisCacheStore extends CacheStore {
  /** A hit with its age, for `SnapshotCacheInfo.ageSeconds`. */
  getEntry<T>(
    key: string,
    schema: ZodType<T>,
    options: CallOptions,
  ): Promise<CacheEntry<T> | null>;
  readonly ttlSeconds: Readonly<Record<CacheTtlClass, number>>;
  close(): Promise<void>;
}

const DEFAULT_SCAN_COUNT = 512;
/** Keys deleted per DEL. Keeps one command from blocking the server. */
const DELETE_CHUNK = 128;
/** Hard stop on a SCAN loop, so a moving keyspace cannot spin forever. */
const MAX_SCAN_ROUNDS = 10_000;

const systemClock: Clock = { now: () => new Date() };

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

type FailureReason = 'timeout' | 'error' | 'circuit-open';

interface CommandFailure {
  readonly ok: false;
  readonly reason: 'timeout' | 'error';
  readonly error?: unknown;
}

type CommandOutcome<T> =
  { readonly ok: true; readonly value: T } | CommandFailure;

/**
 * Races a command against its timeout. The losing promise keeps its
 * rejection handler, so an abandoned command cannot surface later as an
 * unhandled rejection.
 */
async function withCommandTimeout<T>(
  command: () => Promise<T>,
  timeoutMs: number,
): Promise<CommandOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const settled = Promise.resolve()
      .then(command)
      .then<CommandOutcome<T>>((value) => ({ ok: true, value }))
      .catch<CommandOutcome<T>>((error: unknown) => ({
        ok: false,
        reason: 'error',
        error,
      }));
    const timedOut = new Promise<CommandOutcome<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: 'timeout' }),
        timeoutMs,
      );
    });
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Envelope {
  readonly storedAtMs: number;
  readonly data: unknown;
}

const encodeEnvelope = (value: unknown, storedAtMs: number): string =>
  JSON.stringify({ v: CACHE_ENVELOPE_VERSION, t: storedAtMs, d: value });

const decodeEnvelope = (raw: string): Envelope | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { v?: unknown; t?: unknown; d?: unknown };
  if (candidate.v !== CACHE_ENVELOPE_VERSION) return null;
  if (typeof candidate.t !== 'number' || !Number.isFinite(candidate.t)) {
    return null;
  }
  return { storedAtMs: candidate.t, data: candidate.d };
};

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown';

class RedisCache implements RedisCacheStore {
  readonly ttlSeconds: Readonly<Record<CacheTtlClass, number>>;
  private readonly client: RedisLike;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly breaker: CircuitBreaker;
  private readonly commandTimeoutMs: number;
  private readonly scanCount: number;
  private healthyFlag = true;

  constructor(options: RedisCacheOptions) {
    this.client = options.client;
    this.logger = options.logger.child({ component: 'cache' });
    this.clock = options.clock ?? systemClock;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
    this.breaker = createCircuitBreaker({
      clock: this.clock,
      ...(options.breaker ?? {}),
    });
  }

  get healthy(): boolean {
    return this.healthyFlag;
  }

  async get<T>(
    key: string,
    schema: ZodType<T>,
    options: CallOptions,
  ): Promise<T | null> {
    const entry = await this.getEntry(key, schema, options);
    return entry === null ? null : entry.value;
  }

  async getEntry<T>(
    key: string,
    schema: ZodType<T>,
    options: CallOptions,
  ): Promise<CacheEntry<T> | null> {
    const outcome = await this.run('get', options, () => this.client.get(key));
    if (!outcome.ok || outcome.value === null) return null;

    const envelope = decodeEnvelope(outcome.value);
    if (envelope === null) {
      await this.discard(key, 'unreadable-envelope', options);
      return null;
    }

    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      await this.discard(key, 'shape-mismatch', options);
      return null;
    }

    const nowMs = this.clock.now().getTime();
    const ageSeconds = Math.max(
      0,
      Math.round((nowMs - envelope.storedAtMs) / 1000),
    );
    return {
      value: parsed.data,
      storedAt: new Date(envelope.storedAtMs),
      ageSeconds,
    };
  }

  async set<T>(
    key: string,
    value: T,
    ttl: CacheTtlClass,
    options: CallOptions,
  ): Promise<void> {
    let payload: string;
    try {
      payload = encodeEnvelope(value, this.clock.now().getTime());
    } catch (error: unknown) {
      this.log(options).warn('cache value is not serialisable', {
        cacheKey: key,
        ttlClass: ttl,
        reason: reasonOf(error),
      });
      return;
    }

    const seconds = this.ttlSeconds[ttl];
    const expires = Number.isFinite(seconds) && seconds > 0;
    await this.run('set', options, () =>
      expires
        ? this.client.setex(key, Math.floor(seconds), payload)
        : this.client.set(key, payload),
    );
  }

  async delete(key: string, options: CallOptions): Promise<void> {
    await this.run('delete', options, () => this.client.del(key));
  }

  async invalidatePattern(
    pattern: string,
    options: CallOptions,
  ): Promise<number> {
    let cursor = '0';
    let removed = 0;
    let rounds = 0;

    do {
      const scanned = await this.run('scan', options, () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount),
      );
      if (!scanned.ok) return removed;

      const [nextCursor, keys] = scanned.value;
      cursor = nextCursor;
      removed += await this.deleteAll(keys, options);
      rounds += 1;
    } while (cursor !== '0' && rounds < MAX_SCAN_ROUNDS);

    if (removed > 0) {
      this.log(options).debug('cache invalidated by pattern', {
        cachePattern: pattern,
        removed,
      });
    }
    return removed;
  }

  async close(): Promise<void> {
    await withCommandTimeout(() => this.client.quit(), this.commandTimeoutMs);
  }

  private async deleteAll(
    keys: readonly string[],
    options: CallOptions,
  ): Promise<number> {
    let removed = 0;
    for (let index = 0; index < keys.length; index += DELETE_CHUNK) {
      const chunk = keys.slice(index, index + DELETE_CHUNK);
      if (chunk.length === 0) continue;
      const outcome = await this.run('delete', options, () =>
        this.client.del(...chunk),
      );
      if (!outcome.ok) return removed;
      removed += outcome.value;
    }
    return removed;
  }

  private async discard(
    key: string,
    reason: 'unreadable-envelope' | 'shape-mismatch',
    options: CallOptions,
  ): Promise<void> {
    this.log(options).debug('cache entry discarded', {
      cacheKey: key,
      reason,
    });
    await this.delete(key, options);
  }

  private async run<T>(
    operation: string,
    options: CallOptions,
    command: () => Promise<T>,
  ): Promise<Outcome<T>> {
    if (options.signal?.aborted === true) return { ok: false };
    if (!this.breaker.canAttempt()) {
      this.markUnhealthy(operation, 'circuit-open', undefined, options);
      return { ok: false };
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const outcome = await withCommandTimeout(command, timeoutMs);
    if (outcome.ok) {
      this.breaker.recordSuccess();
      this.markHealthy(options);
      return outcome;
    }

    this.breaker.recordFailure();
    this.markUnhealthy(operation, outcome.reason, outcome.error, options);
    return { ok: false };
  }

  /** Logs the transition only, never the operation that caused it. */
  private markUnhealthy(
    operation: string,
    reason: FailureReason,
    error: unknown,
    options: CallOptions,
  ): void {
    if (!this.healthyFlag) return;
    this.healthyFlag = false;
    this.log(options).warn('cache degraded, serving without it', {
      cacheOp: operation,
      reason,
      detail: error === undefined ? undefined : reasonOf(error),
    });
  }

  private markHealthy(options: CallOptions): void {
    if (this.healthyFlag) return;
    this.healthyFlag = true;
    this.log(options).info('cache recovered', {});
  }

  private log(options: CallOptions): Logger {
    return this.logger.withTraceId(options.traceId);
  }
}

/** Builds the cache store. Every dependency is injectable for tests. */
export function createRedisCache(options: RedisCacheOptions): RedisCacheStore {
  return new RedisCache(options);
}
