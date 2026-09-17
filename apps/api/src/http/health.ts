/**
 * Liveness and readiness.
 *
 * `/api/health` says the process is up. `/api/ready` says whether the
 * dependencies are, honestly and separately: Postgres holds the board
 * definitions and the audit log, so without it the service cannot serve
 * or write; Redis only makes it fast, so a board with a cold cache is
 * *degraded but serving* and must not be taken out of rotation for it.
 *
 * Neither route is authenticated, so neither reveals anything but a
 * status word and a trace id.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CacheStore,
  CallOptions,
  Clock,
  ConfigStore,
  Logger,
} from '../ports.js';
import { requestLogger, requestTraceId } from './context.js';

export const HEALTH_PATH = '/api/health';
export const READY_PATH = '/api/ready';

/** Probe key: reading it is the cheapest proof Redis answers commands. */
export const CACHE_PROBE_KEY = 'eg:v1:health:probe';
const probeSchema = z.string();

export type ComponentStatus = 'up' | 'down';
export type ReadinessStatus = 'ready' | 'degraded' | 'unavailable';

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly components: {
    readonly postgres: ComponentStatus;
    readonly redis: ComponentStatus;
  };
  readonly traceId: string;
}

export interface HealthDeps {
  readonly config: ConfigStore;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly orgId: string;
  /** Explicit timeout, so a wedged dependency cannot wedge the probe. */
  readonly probeTimeoutMs?: number;
}

/** Postgres is up when it answers a real, indexed read. */
export async function probePostgres(
  deps: HealthDeps,
  options: CallOptions,
): Promise<ComponentStatus> {
  try {
    await deps.config.listBoardDefinitions(deps.orgId, options);
    return 'up';
  } catch {
    return 'down';
  }
}

/**
 * Redis is up when a command completes and the store's own breaker is
 * closed. `CacheStore` never throws, so `healthy` is the real answer.
 */
export async function probeRedis(
  deps: HealthDeps,
  options: CallOptions,
): Promise<ComponentStatus> {
  try {
    await deps.cache.get(CACHE_PROBE_KEY, probeSchema, options);
  } catch {
    return 'down';
  }
  return deps.cache.healthy ? 'up' : 'down';
}

/** Both probes, and the one word that follows from them. */
export async function checkReadiness(
  deps: HealthDeps,
  options: CallOptions,
): Promise<ReadinessReport> {
  const [postgres, redis] = await Promise.all([
    probePostgres(deps, options),
    probeRedis(deps, options),
  ]);
  const status: ReadinessStatus =
    postgres === 'down' ? 'unavailable' : redis === 'up' ? 'ready' : 'degraded';
  return {
    status,
    components: { postgres, redis },
    traceId: options.traceId,
  };
}

/** Degraded still serves, so only `unavailable` fails the probe. */
export function readinessStatusCode(status: ReadinessStatus): number {
  return status === 'unavailable' ? 503 : 200;
}

export async function healthRoutes(
  app: FastifyInstance,
  deps: HealthDeps,
): Promise<void> {
  app.get(HEALTH_PATH, async (request, reply) =>
    reply.send({
      status: 'ok',
      time: deps.clock.now().toISOString(),
      traceId: requestTraceId(request),
    }),
  );

  app.get(READY_PATH, async (request, reply) => {
    const traceId = requestTraceId(request);
    const timeoutMs = deps.probeTimeoutMs;
    const options: CallOptions = {
      traceId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    const report = await checkReadiness(deps, options);
    if (report.status !== 'ready') {
      requestLogger(request, deps.logger).warn('readiness degraded', {
        status: report.status,
        postgres: report.components.postgres,
        redis: report.components.redis,
      });
    }
    return reply.code(readinessStatusCode(report.status)).send(report);
  });
}
