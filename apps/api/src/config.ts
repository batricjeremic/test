/**
 * Environment configuration, validated once at startup.
 *
 * Serves "Architecture", "Caching, rate limits and realtime" and the
 * ExpertGroup rule that every outbound call has an explicit timeout.
 * Values are secrets or connection strings: this module never logs them,
 * and `redactConfig` exists so callers do not have to remember that.
 */
import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { CacheTtlClass, LogLevel } from './ports.js';

/** Variables whose value must never appear in an error or a log line. */
export const SECRET_ENV_KEYS = [
  'ADO_SERVICE_TOKEN',
  'REDIS_URL',
  'DATABASE_URL',
] as const;

/** TTLs from the spec's cache table. Zero means "no expiry". */
export const DEFAULT_CACHE_TTL_SECONDS = {
  'projects-teams': 86_400,
  'team-metadata': 21_600,
  'board-columns': 21_600,
  capacity: 3_600,
  'board-snapshot': 60,
  'column-mapping': 0,
  acl: 900,
} satisfies Record<CacheTtlClass, number>;

const MAX_INT = Number.MAX_SAFE_INTEGER;

const integerVar = (fallback: number, min: number, max = MAX_INT) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === '') return fallback;
      if (typeof value === 'string') return Number(value);
      return value;
    },
    z
      .number({ invalid_type_error: 'must be a whole number' })
      .int({ message: 'must be a whole number' })
      .min(min, { message: `must be at least ${min}` })
      .max(max, { message: `must be at most ${max}` }),
  );

const urlVar = (protocols: readonly string[]) =>
  z
    .string({ required_error: 'is required' })
    .min(1, { message: 'is required' })
    .superRefine((value, ctx) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be an absolute URL',
        });
        return;
      }
      if (!protocols.includes(parsed.protocol)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must use one of ${protocols.join(', ')}`,
        });
      }
    });

const logLevelVar = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], {
    errorMap: () => ({
      message: 'must be one of trace, debug, info, warn, error, fatal',
    }),
  })
  .default('info');

/** The raw variables, one key per environment variable name. */
export const envSchema = z.object({
  PORT: integerVar(8_080, 1, 65_535),
  LOG_LEVEL: logLevelVar,

  ADO_ORG_URL: urlVar(['https:']),
  ADO_SERVICE_TOKEN: z
    .string({ required_error: 'is required' })
    .min(8, { message: 'is required' }),
  ADO_REQUEST_TIMEOUT_MS: integerVar(10_000, 1),

  REDIS_URL: urlVar(['redis:', 'rediss:']),
  REDIS_REQUEST_TIMEOUT_MS: integerVar(1_000, 1),

  DATABASE_URL: urlVar(['postgres:', 'postgresql:']),
  DATABASE_REQUEST_TIMEOUT_MS: integerVar(5_000, 1),

  HTTP_REQUEST_TIMEOUT_MS: integerVar(15_000, 1),

  SYNC_CONCURRENCY: integerVar(2, 1, 64),
  SYNC_RATE_BUDGET_PER_MINUTE: integerVar(200, 1),

  CACHE_TTL_PROJECTS_TEAMS_SECONDS: integerVar(
    DEFAULT_CACHE_TTL_SECONDS['projects-teams'],
    0,
  ),
  CACHE_TTL_TEAM_METADATA_SECONDS: integerVar(
    DEFAULT_CACHE_TTL_SECONDS['team-metadata'],
    0,
  ),
  CACHE_TTL_BOARD_COLUMNS_SECONDS: integerVar(
    DEFAULT_CACHE_TTL_SECONDS['board-columns'],
    0,
  ),
  CACHE_TTL_CAPACITY_SECONDS: integerVar(DEFAULT_CACHE_TTL_SECONDS.capacity, 0),
  CACHE_TTL_BOARD_SNAPSHOT_SECONDS: integerVar(
    DEFAULT_CACHE_TTL_SECONDS['board-snapshot'],
    0,
  ),
  CACHE_TTL_COLUMN_MAPPING_SECONDS: integerVar(
    DEFAULT_CACHE_TTL_SECONDS['column-mapping'],
    0,
  ),
  CACHE_TTL_ACL_SECONDS: integerVar(DEFAULT_CACHE_TTL_SECONDS.acl, 0),
});

export type Env = z.infer<typeof envSchema>;

export interface AdoConfig {
  /** e.g. `https://dev.azure.com/expertgroup`, no trailing slash. */
  readonly orgUrl: string;
  /** Service identity credential used for every read. Secret. */
  readonly serviceToken: string;
  readonly requestTimeoutMs: number;
}

export interface AppConfig {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly ado: AdoConfig;
  readonly redis: { readonly url: string; readonly requestTimeoutMs: number };
  readonly postgres: {
    readonly url: string;
    readonly requestTimeoutMs: number;
  };
  readonly http: { readonly requestTimeoutMs: number };
  readonly cache: {
    readonly ttlSeconds: Readonly<Record<CacheTtlClass, number>>;
  };
  readonly sync: {
    readonly concurrency: number;
    readonly rateBudgetPerMinute: number;
  };
}

/** Anything with string-ish values: `process.env` satisfies it. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const isSecretKey = (key: string): boolean =>
  (SECRET_ENV_KEYS as readonly string[]).includes(key);

const describeIssue = (issue: z.ZodIssue): string => {
  const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
  const detail = isSecretKey(key)
    ? 'is missing or invalid (value not shown)'
    : issue.message;
  return `${key}: ${detail}`;
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

/**
 * Validates the environment and returns the typed configuration.
 * Throws a single `ConfigError` listing every missing or invalid
 * variable at once, so one restart tells you everything that is wrong.
 */
export function parseConfig(source: EnvSource): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(describeIssue).sort();
    throw new ConfigError([...new Set(issues)]);
  }
  const env = result.data;
  return {
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    ado: {
      orgUrl: trimTrailingSlash(env.ADO_ORG_URL),
      serviceToken: env.ADO_SERVICE_TOKEN,
      requestTimeoutMs: env.ADO_REQUEST_TIMEOUT_MS,
    },
    redis: {
      url: env.REDIS_URL,
      requestTimeoutMs: env.REDIS_REQUEST_TIMEOUT_MS,
    },
    postgres: {
      url: env.DATABASE_URL,
      requestTimeoutMs: env.DATABASE_REQUEST_TIMEOUT_MS,
    },
    http: { requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS },
    cache: {
      ttlSeconds: {
        'projects-teams': env.CACHE_TTL_PROJECTS_TEAMS_SECONDS,
        'team-metadata': env.CACHE_TTL_TEAM_METADATA_SECONDS,
        'board-columns': env.CACHE_TTL_BOARD_COLUMNS_SECONDS,
        capacity: env.CACHE_TTL_CAPACITY_SECONDS,
        'board-snapshot': env.CACHE_TTL_BOARD_SNAPSHOT_SECONDS,
        'column-mapping': env.CACHE_TTL_COLUMN_MAPPING_SECONDS,
        acl: env.CACHE_TTL_ACL_SECONDS,
      },
    },
    sync: {
      concurrency: env.SYNC_CONCURRENCY,
      rateBudgetPerMinute: env.SYNC_RATE_BUDGET_PER_MINUTE,
    },
  };
}

/**
 * A view of the configuration that is safe to log: no credentials, no
 * connection strings, hosts only.
 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const host = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return '(unparseable)';
    }
  };
  return {
    port: config.port,
    logLevel: config.logLevel,
    adoOrgHost: host(config.ado.orgUrl),
    adoRequestTimeoutMs: config.ado.requestTimeoutMs,
    redisHost: host(config.redis.url),
    redisRequestTimeoutMs: config.redis.requestTimeoutMs,
    postgresHost: host(config.postgres.url),
    postgresRequestTimeoutMs: config.postgres.requestTimeoutMs,
    httpRequestTimeoutMs: config.http.requestTimeoutMs,
    cacheTtlSeconds: config.cache.ttlSeconds,
    syncConcurrency: config.sync.concurrency,
    syncRateBudgetPerMinute: config.sync.rateBudgetPerMinute,
  };
}
