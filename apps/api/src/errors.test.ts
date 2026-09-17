import { describe, expect, it } from 'vitest';
import {
  AppError,
  isAppError,
  mapAdoError,
  PermissionDeniedError,
  RateLimitedError,
  RevisionConflictError,
  RuleViolationError,
  ServiceUnavailableError,
  toAppError,
  TransitionNotAllowedError,
  UnauthorizedError,
  UpstreamError,
} from './errors.js';

describe('AppError', () => {
  it('carries a status, a stable code and a user-facing message', () => {
    const error = new PermissionDeniedError('caller lacks vso.work_write');
    expect(error.status).toBe(403);
    expect(error.code).toBe('permission_denied');
    expect(error.userMessage).not.toBe(error.message);
    expect(isAppError(error)).toBe(true);
    expect(error.name).toBe('PermissionDeniedError');
  });

  it('serialises to the shared ApiError body', () => {
    const error = new RevisionConflictError('rev 7 != 9', 9, {
      details: { workItemId: 4211 },
    });
    expect(error.toApiError('trace-1')).toEqual({
      code: 'revision_conflict',
      message: 'Someone else changed this card. It has been refreshed.',
      status: 409,
      traceId: 'trace-1',
      details: { workItemId: 4211 },
    });
    expect(error.currentRev).toBe(9);
  });

  it('omits an empty details bag', () => {
    const payload = new UnauthorizedError().toApiError('trace-2');
    expect(payload).not.toHaveProperty('details');
    expect(payload.status).toBe(401);
  });
});

describe('mapAdoError', () => {
  const body = (message: string, typeKey?: string) => ({
    message,
    typeKey,
    typeName: 'Microsoft.TeamFoundation.WorkItemTracking.Server.Whatever',
    errorCode: 0,
    eventId: 3200,
  });

  it('maps a failed test operation to a revision conflict', () => {
    const error = mapAdoError({
      status: 400,
      body: body('The "test" operation failed for path /rev'),
    });
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error.status).toBe(409);
  });

  it('maps a 412 to a revision conflict', () => {
    expect(mapAdoError({ status: 412, body: {} })).toBeInstanceOf(
      RevisionConflictError,
    );
  });

  it('maps a rule validation to a rule violation and names the field', () => {
    const error = mapAdoError({
      status: 400,
      body: body(
        "The field 'Microsoft.VSTS.Common.Activity' is required.",
        'RuleValidationException',
      ),
    });
    expect(error).toBeInstanceOf(RuleViolationError);
    expect((error as RuleViolationError).field).toBe(
      'Microsoft.VSTS.Common.Activity',
    );
    expect(error.userMessage).toContain('Activity');
  });

  it('maps a forbidden transition to transition-not-allowed', () => {
    const error = mapAdoError({
      status: 400,
      body: body(
        'The transition from New to Done is not allowed.',
        'RuleValidationException',
      ),
    });
    expect(error).toBeInstanceOf(TransitionNotAllowedError);
    expect(error.code).toBe('transition_not_allowed');
  });

  it('maps 401 and 403 to the auth errors', () => {
    expect(mapAdoError({ status: 401, body: {} })).toBeInstanceOf(
      UnauthorizedError,
    );
    expect(mapAdoError({ status: 403, body: {} })).toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('maps a 429 and carries Retry-After through', () => {
    const error = mapAdoError({
      status: 429,
      body: body('Too many requests'),
      headers: { 'retry-after': '17' },
    });
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(17);
  });

  it('maps a 503 to service-unavailable, which rolls the move back', () => {
    const error = mapAdoError({
      status: 503,
      body: 'upstream down',
      headers: { 'retry-after': ['5'] },
      operation: 'PATCH /_apis/wit/workitems/4211',
    });
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).retryAfterSeconds).toBe(5);
    expect(error.details['operation']).toBe('PATCH /_apis/wit/workitems/4211');
  });

  it('falls back to an upstream error for anything unrecognised', () => {
    const error = mapAdoError({ status: 418, body: undefined });
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).upstreamStatus).toBe(418);
    expect(error.message).toBe('Azure DevOps returned 418');
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new UnauthorizedError();
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error as internal', () => {
    const wrapped = toAppError(new Error('boom'));
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.status).toBe(500);
    expect(wrapped.code).toBe('internal_error');
  });

  it('wraps a thrown non-error', () => {
    expect(toAppError('nope').code).toBe('internal_error');
  });
});
