import { describe, expect, it } from 'vitest';
import {
  InternalError,
  RevisionConflictError,
  ValidationError,
} from '../errors.js';
import { httpErrorFor, toSafeApiError } from './error-handler.js';

describe('httpErrorFor', () => {
  it('passes an AppError through untouched', () => {
    const error = new ValidationError('bad body');
    expect(httpErrorFor(error)).toBe(error);
  });

  it('keeps the status Fastify chose, but not its message', () => {
    const fastifyError = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });

    const mapped = httpErrorFor(fastifyError);

    expect(mapped.status).toBe(413);
    expect(mapped.code).toBe('validation_failed');
    expect(mapped.userMessage).toBe('That request was too large.');
  });

  it('turns anything else into an internal error', () => {
    const mapped = httpErrorFor(new Error('pg: password=hunter2'));
    expect(mapped.status).toBe(500);
    expect(mapped.toApiError('t').message).toBe('Something went wrong.');
  });
});

describe('toSafeApiError', () => {
  it('keeps details on a client error, where they help', () => {
    const error = new RevisionConflictError('changed', 9, {
      details: { workItemId: 101 },
    });

    expect(toSafeApiError(error, 'trace-1')).toEqual({
      code: 'revision_conflict',
      message: 'Someone else changed this card. It has been refreshed.',
      status: 409,
      traceId: 'trace-1',
      details: { workItemId: 101 },
    });
  });

  it('withholds them on a server error', () => {
    const error = new InternalError('boom', {
      details: { connectionString: 'postgres://user:pw@host/db' },
    });

    const body = toSafeApiError(error, 'trace-2');

    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });
});
