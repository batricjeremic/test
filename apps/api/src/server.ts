/**
 * The process: listen, then die politely.
 *
 * On SIGTERM or SIGINT the server stops accepting connections, gives the
 * requests already in flight a bounded window to finish, and only then
 * lets the container close the sync worker, the sockets, Redis and
 * Postgres. The window is bounded on purpose: a shutdown that waits
 * forever for one wedged request is an outage, not a graceful stop.
 *
 * Migrations are not run here. They are applied by the pipeline.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { AppConfig, EnvSource } from './config.js';
import { parseConfig, redactConfig } from './config.js';
import { createContainer } from './container.js';
import type { AppContainer } from './container.js';
import { toAppError } from './errors.js';
import { createLogger, newTraceId } from './logging.js';
import type { Logger } from './ports.js';

/** How long in-flight requests get once the listener is closed. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/** Signals a container orchestrator uses to ask for a clean stop. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly container: AppContainer;
  readonly address: string;
  close(reason?: string): Promise<void>;
}

export interface StartServerOptions {
  readonly config: AppConfig;
  readonly env?: EnvSource;
  readonly host?: string;
  /** Overrides `config.port`; 0 asks the OS for a free one. */
  readonly port?: number;
  readonly drainTimeoutMs?: number;
  readonly logger?: Logger;
}

/** Resolves once `work` settles or the window closes, whichever is first. */
async function withDeadline(
  work: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((done) => {
    timer = setTimeout(() => {
      onTimeout();
      done();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Builds the container and the app, and starts listening. */
export async function startServer(
  options: StartServerOptions,
): Promise<RunningServer> {
  const config = options.config;
  const container = createContainer({
    config,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined
      ? {}
      : { overrides: { logger: options.logger } }),
    enableSync: true,
  });
  const logger = container.ports.logger;

  const app = await buildApp({ container });
  container.start();

  const address = await app.listen({
    port: options.port ?? config.port,
    host: options.host ?? '0.0.0.0',
  });
  logger.info('board api listening', {
    address,
    ...redactConfig(config),
  });

  let closing: Promise<void> | null = null;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  const close = async (reason = 'shutdown'): Promise<void> => {
    closing ??= (async () => {
      logger.info('shutdown started', { reason });
      // Stop accepting, then drain — with a deadline, never unbounded.
      await withDeadline(app.close(), drainTimeoutMs, () => {
        logger.warn('drain timed out, closing anyway', {
          reason,
          drainTimeoutMs,
        });
      });
      await container.shutdown(reason);
      logger.info('shutdown complete', { reason });
    })();
    return closing;
  };

  return { app, container, address, close };
}

/** Wires SIGTERM and SIGINT to one graceful stop. Returns a detacher. */
export function installSignalHandlers(
  server: RunningServer,
  logger: Logger,
): () => void {
  const handlers = SHUTDOWN_SIGNALS.map((signal) => {
    const handler = (): void => {
      void server.close(signal).catch((error: unknown) => {
        logger.error('shutdown failed', { code: toAppError(error).code });
        process.exitCode = 1;
      });
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

/** True when this file is the process entry point. */
export function isCliEntrypoint(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  const withoutExtension = (path: string): string =>
    path.replace(/\.(?:js|ts|mjs|cjs)$/u, '');
  return (
    withoutExtension(fileURLToPath(import.meta.url)) ===
    withoutExtension(resolve(entry))
  );
}

/** Process entry. Returns the exit code rather than calling `exit`. */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const traceId = newTraceId();
  let config: AppConfig;
  try {
    config = parseConfig(env);
  } catch (error) {
    const failure = toAppError(error);
    createLogger({ level: 'info', traceId, name: 'board-api' }).error(
      'configuration is invalid',
      { code: failure.code, details: failure.details },
    );
    return 78;
  }

  const logger = createLogger({
    level: config.logLevel,
    traceId,
    name: 'board-api',
  });
  try {
    const server = await startServer({ config, env, logger });
    installSignalHandlers(server, logger);
    return 0;
  } catch (error) {
    const failure = toAppError(error);
    logger.error('server failed to start', {
      code: failure.code,
      status: failure.status,
      message: failure.message,
    });
    return 1;
  }
}

if (isCliEntrypoint(process.argv)) {
  process.exitCode = await main();
}
