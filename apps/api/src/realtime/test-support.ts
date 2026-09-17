/**
 * Fakes for the realtime tests. Nothing here opens a socket or a
 * connection: the hub, the webhook and the status builder are all driven
 * through their ports, as the ExpertGroup testing rule requires.
 */
import type { BoardCard } from '@eg/shared';
import type { AdoWorkItemUpdatedEvent } from '../ado/types.js';
import type { LogFields, Logger } from '../ports.js';
import type { ManagedSocket } from './socket.js';

export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that records instead of writing. */
export class RecordingLogger implements Logger {
  readonly traceId: string;
  readonly lines: LoggedLine[];
  private readonly bindings: LogFields;

  constructor(
    traceId = 'trace-test',
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

export interface RecordedClose {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/** An in-memory WebSocket that records everything written to it. */
export class FakeSocket implements ManagedSocket {
  readonly sent: string[] = [];
  readonly closes: RecordedClose[] = [];
  pings = 0;
  terminated = 0;
  /** When set, `send` throws it, as a half-open socket does. */
  sendFailure: Error | null = null;
  readonly #listeners = new Map<string, (() => void)[]>();

  send(data: string): void {
    if (this.sendFailure !== null) throw this.sendFailure;
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated += 1;
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as () => void);
    this.#listeners.set(event, listeners);
  }

  /** Fires an event the way `ws` would. */
  emit(event: string): void {
    for (const listener of this.#listeners.get(event) ?? []) listener();
  }

  /** Every frame it was sent, parsed back. */
  frames(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame) as unknown);
  }
}

/** A card that satisfies `boardCardSchema`, for delta assertions. */
export const sampleCard = (overrides: Partial<BoardCard> = {}): BoardCard => ({
  workItemId: 42,
  project: 'Delivery',
  teamId: 'team-1',
  iterationId: 'iteration-1',
  title: 'Wire the hub',
  type: 'User Story',
  assignedTo: { descriptor: 'aad.person-1', displayName: 'A Person' },
  state: 'Active',
  sourceColumn: 'In Progress',
  canonicalColumnId: 'canon-doing',
  remainingWork: 4,
  tags: ['board'],
  rev: 7,
  ...overrides,
});

/** A `workitem.updated` document as Azure DevOps posts it. */
export const sampleEvent = (
  fields: Record<string, { newValue?: unknown; oldValue?: unknown }> = {},
): AdoWorkItemUpdatedEvent => ({
  eventType: 'workitem.updated',
  resource: {
    id: 1001,
    workItemId: 42,
    rev: 8,
    fields,
  },
});
