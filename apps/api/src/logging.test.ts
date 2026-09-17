import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import {
  createLogger,
  newTraceId,
  REDACTED,
  sanitizeLogFields,
} from './logging.js';

interface Capture {
  readonly destination: DestinationStream;
  lines(): Record<string, unknown>[];
}

const capture = (): Capture => {
  const raw: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        raw.push(chunk);
      },
    },
    lines() {
      return raw
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
};

describe('sanitizeLogFields', () => {
  it('redacts credentials at the top level', () => {
    const out = sanitizeLogFields({
      accessToken: 'eyJ0eXAi',
      authorization: 'Bearer eyJ0eXAi',
      workItemId: 4211,
    });
    expect(out['accessToken']).toBe(REDACTED);
    expect(out['authorization']).toBe(REDACTED);
    expect(out['workItemId']).toBe(4211);
  });

  it('redacts personal data at depth but keeps the descriptor', () => {
    const out = sanitizeLogFields({
      card: { assignedTo: { descriptor: 'aad.YWJj', displayName: 'Ana' } },
    });
    const card = out['card'] as Record<string, unknown>;
    const assignedTo = card['assignedTo'] as Record<string, unknown>;
    expect(assignedTo['displayName']).toBe(REDACTED);
    expect(assignedTo['descriptor']).toBe('aad.YWJj');
  });

  it('redacts inside arrays', () => {
    const out = sanitizeLogFields({
      people: [{ descriptor: 'aad.YWJj', email: 'a@b.rs' }],
    });
    const people = out['people'] as Record<string, unknown>[];
    expect(people[0]?.['email']).toBe(REDACTED);
  });

  it('survives a cycle', () => {
    const node: Record<string, unknown> = { id: 1 };
    node['self'] = node;
    expect(() => sanitizeLogFields({ node })).not.toThrow();
  });

  it('keeps an error readable', () => {
    const out = sanitizeLogFields({ err: new Error('boom') });
    const err = out['err'] as Record<string, unknown>;
    expect(err['message']).toBe('boom');
  });
});

describe('createLogger', () => {
  it('puts the trace id on every line', () => {
    const sink = capture();
    const logger = createLogger({
      level: 'debug',
      traceId: 'trace-1',
      destination: sink.destination,
    });
    logger.info('board loaded');
    logger.debug('cache hit');
    logger.warn('degraded');
    logger.error('failed');
    const lines = sink.lines();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line['traceId']).toBe('trace-1');
      expect(line['service']).toBe('board-api');
    }
    expect(lines[0]?.['msg']).toBe('board loaded');
    expect(lines[0]?.['level']).toBe('info');
  });

  it('never writes a token or a display name', () => {
    const sink = capture();
    const logger = createLogger({
      level: 'info',
      traceId: 'trace-2',
      destination: sink.destination,
    });
    logger.info('ado call', {
      operation: 'PATCH /_apis/wit/workitems/4211',
      headers: { authorization: 'Bearer eyJ0eXAi' },
      accessToken: 'eyJ0eXAi',
      assignedTo: { descriptor: 'aad.YWJj', displayName: 'Ana Ilic' },
      workItemId: 4211,
    });
    const serialised = JSON.stringify(sink.lines());
    expect(serialised).not.toContain('eyJ0eXAi');
    expect(serialised).not.toContain('Ana Ilic');
    expect(serialised).toContain('aad.YWJj');
    expect(serialised).toContain('4211');
  });

  it('keeps the trace id through child bindings and redacts them too', () => {
    const sink = capture();
    const root = createLogger({
      level: 'info',
      traceId: 'trace-3',
      destination: sink.destination,
    });
    const child = root.child({ boardId: 'board-1', token: 'secret-value' });
    expect(child.traceId).toBe('trace-3');
    child.info('scoped');
    const line = sink.lines()[0];
    expect(line?.['boardId']).toBe('board-1');
    expect(line?.['traceId']).toBe('trace-3');
    expect(line?.['token']).toBe(REDACTED);
  });

  it('rebinds the trace id for a new request', () => {
    const sink = capture();
    const root = createLogger({
      level: 'info',
      traceId: 'trace-4',
      destination: sink.destination,
    });
    const next = root.withTraceId('trace-5');
    next.info('second request');
    expect(next.traceId).toBe('trace-5');
    expect(sink.lines()[0]?.['traceId']).toBe('trace-5');
  });

  it('honours the level, so debug is dropped at info', () => {
    const sink = capture();
    const logger = createLogger({
      level: 'info',
      traceId: 'trace-6',
      destination: sink.destination,
    });
    logger.debug('not written');
    expect(sink.lines()).toHaveLength(0);
  });

  it('mints a trace id when none is supplied', () => {
    const sink = capture();
    const logger = createLogger({
      level: 'info',
      destination: sink.destination,
    });
    expect(logger.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(newTraceId()).not.toBe(logger.traceId);
  });
});
