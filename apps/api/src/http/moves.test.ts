import type { MoveRequest, MoveResult } from '@eg/shared';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ADO_JSON_PATCH_CONTENT_TYPE } from '../ado/types.js';
import {
  RateLimitedError,
  RevisionConflictError,
  RuleViolationError,
} from '../errors.js';
import {
  bearer,
  buildTestApp,
  DEV_BOARD,
  makeAcl,
  seedDeliveryBoard,
  TEST_BOARD_ID,
  type TestHarness,
} from './test-support.js';

const MOVE: MoveRequest = {
  boardId: TEST_BOARD_ID,
  workItemId: 101,
  rev: 7,
  fromCanonicalColumnId: 'col-doing',
  toCanonicalColumnId: 'col-done',
};

const withBoard = async (
  body: (harness: TestHarness) => Promise<void>,
): Promise<void> => {
  const harness = await buildTestApp();
  seedDeliveryBoard(harness);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

const move = async (
  harness: TestHarness,
  request: Partial<MoveRequest> = {},
  token = 'reader-token',
): Promise<LightMyRequestResponse> =>
  harness.app.inject({
    method: 'POST',
    url: '/api/moves',
    headers: bearer(token),
    payload: { ...MOVE, ...request },
  });

const resultOf = (response: LightMyRequestResponse): MoveResult =>
  response.json() as MoveResult;

describe('POST /api/moves', () => {
  it('writes column and state in one patch, as the calling user', async () => {
    await withBoard(async (harness) => {
      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(200);
      expect(result.status).toBe('applied');
      if (result.status !== 'applied') return;
      expect(result.card.canonicalColumnId).toBe('col-done');
      expect(result.card.rev).toBe(8);
      expect(result.stateChanged).toBe(true);

      // One document: the rev test, the board column, the state.
      const [update] = harness.ado.updates;
      expect(update?.patch).toEqual([
        { op: 'test', path: '/rev', value: 7 },
        {
          op: 'add',
          path: `/fields/WEF_${DEV_BOARD.replace(/-/gu, '').toUpperCase()}_Kanban.Column`,
          value: 'Done',
        },
        { op: 'add', path: '/fields/System.State', value: 'Closed' },
      ]);
      // Never the service identity: the Boards history must name the user.
      expect(update?.auth.kind).toBe('user');
      expect(ADO_JSON_PATCH_CONTENT_TYPE).toBe('application/json-patch+json');
    });
  });

  it('audits the successful attempt', async () => {
    await withBoard(async (harness) => {
      await move(harness);

      expect(harness.config.audits).toHaveLength(1);
      expect(harness.config.audits[0]).toMatchObject({
        boardId: TEST_BOARD_ID,
        actor: 'aad.reader',
        workItemId: 101,
        from: 'col-doing',
        to: 'col-done',
        result: { outcome: 'success', newRev: 8, stateChanged: true },
      });
    });
  });

  it('invalidates the board snapshots and publishes the delta', async () => {
    await withBoard(async (harness) => {
      await harness.app.inject({
        url: `/api/boards/${TEST_BOARD_ID}/sprint`,
        headers: bearer('reader-token'),
      });
      const cachedSnapshots = () =>
        [...harness.redis.values.keys()].filter((key) =>
          key.includes(':snapshot:'),
        );
      expect(cachedSnapshots()).toHaveLength(1);

      await move(harness);

      expect(cachedSnapshots()).toHaveLength(0);
      expect(harness.publisher.published).toHaveLength(1);
      expect(harness.publisher.published[0]).toMatchObject({
        boardId: TEST_BOARD_ID,
        origin: 'own-write',
        delta: {
          kind: 'card-moved',
          workItemId: 101,
          fromCanonicalColumnId: 'col-doing',
          toCanonicalColumnId: 'col-done',
          state: 'Closed',
        },
      });
    });
  });

  it('refuses an unmapped target before any Azure DevOps call', async () => {
    await withBoard(async (harness) => {
      const response = await move(harness, {
        toCanonicalColumnId: 'col-blocked',
      });
      const result = resultOf(response);

      expect(response.statusCode).toBe(409);
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.failure.reason).toBe('mapping-missing');
      expect(result.failure.message).toContain('Blocked');
      // Not one call: the drop should never have been offered.
      expect(harness.ado.callCount).toBe(0);
      expect(harness.config.audits[0]?.result).toMatchObject({
        outcome: 'failure',
        failure: { reason: 'mapping-missing' },
      });
    });
  });

  it('refuses a target that team has no mapping row for', async () => {
    await withBoard(async (harness) => {
      // `team-data` maps no column onto col-done, `team-dev` does.
      const response = await move(harness, {
        workItemId: 201,
        rev: 2,
        fromCanonicalColumnId: 'col-todo',
      });
      const result = resultOf(response);

      expect(response.statusCode).toBe(409);
      if (result.status !== 'failed') throw new Error('expected a refusal');
      expect(result.failure.reason).toBe('mapping-missing');
      expect(result.failure).toMatchObject({
        teamId: 'team-data',
        canonicalColumnId: 'col-done',
      });
      expect(harness.ado.count('updateWorkItem')).toBe(0);
    });
  });

  it('reports a revision conflict with the card to snap back to', async () => {
    await withBoard(async (harness) => {
      harness.ado.updateFailure = new RevisionConflictError(
        'TF401232: the work item has been changed',
        9,
      );

      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(409);
      if (result.status !== 'failed') throw new Error('expected a failure');
      expect(result.failure.reason).toBe('revision-conflict');
      expect(result.failure).toMatchObject({
        currentRev: 9,
        currentCanonicalColumnId: 'col-doing',
        changedBy: { descriptor: 'aad.milos', displayName: 'Milos' },
      });
      expect(result.card?.workItemId).toBe(101);
      expect(harness.config.audits[0]?.result).toMatchObject({
        outcome: 'failure',
        failure: { reason: 'revision-conflict' },
      });
    });
  });

  it('catches a stale rev before spending a round trip', async () => {
    await withBoard(async (harness) => {
      const response = await move(harness, { rev: 3 });
      const result = resultOf(response);

      expect(response.statusCode).toBe(409);
      if (result.status !== 'failed') throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        reason: 'revision-conflict',
        currentRev: 7,
      });
      expect(harness.ado.count('updateWorkItem')).toBe(0);
    });
  });

  it('names the field a rule violation blocked on', async () => {
    await withBoard(async (harness) => {
      harness.ado.updateFailure = new RuleViolationError(
        "The field 'Microsoft.VSTS.Common.Activity' is required",
        'Microsoft.VSTS.Common.Activity',
      );

      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(422);
      if (result.status !== 'failed') throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        reason: 'rule-violation',
        field: 'Microsoft.VSTS.Common.Activity',
        fieldDisplayName: 'Activity',
        targetState: 'Closed',
      });
      expect(result.failure.reason === 'rule-violation').toBe(true);
      if (result.failure.reason !== 'rule-violation') return;
      expect(result.failure.workItemUrl).toBe(
        'https://dev.azure.com/expertgroup/_workitems/edit/101',
      );
    });
  });

  it('reports a throttled service as busy, with the retry hint', async () => {
    await withBoard(async (harness) => {
      harness.ado.updateFailure = new RateLimitedError('too many', 12, {
        details: { attempts: 3 },
      });

      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(503);
      if (result.status !== 'failed') throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        reason: 'service-unavailable',
        attempts: 3,
        retryAfterSeconds: 12,
      });
    });
  });

  it('refuses a move into a project the caller cannot write', async () => {
    await withBoard(async (harness) => {
      harness.acl.acl = makeAcl({ writableProjectIds: ['Data'] });

      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(403);
      if (result.status !== 'failed') throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        reason: 'permission-denied',
        projectId: 'Delivery',
        projectName: 'Delivery',
      });
      expect(harness.ado.count('updateWorkItem')).toBe(0);
      expect(harness.config.audits).toHaveLength(1);
    });
  });

  it('does not turn a saved move into a failure when the audit fails', async () => {
    await withBoard(async (harness) => {
      harness.config.auditFailure = new Error('audit table is unreachable');

      const response = await move(harness);
      const result = resultOf(response);

      expect(response.statusCode).toBe(200);
      expect(result.status).toBe('applied');
      expect(harness.config.audits).toHaveLength(0);
      expect(
        harness.logger.matching('audit append failed').length,
      ).toBeGreaterThan(0);
    });
  });

  it('validates the body and refuses an unknown board', async () => {
    await withBoard(async (harness) => {
      const malformed = await harness.app.inject({
        method: 'POST',
        url: '/api/moves',
        headers: bearer('reader-token'),
        payload: { boardId: TEST_BOARD_ID, workItemId: 'one' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('validation_failed');

      const unknownBoard = await move(harness, { boardId: 'board-nope' });
      expect(unknownBoard.statusCode).toBe(404);
      expect(unknownBoard.json().code).toBe('not_found');

      const unknownCard = await move(harness, { workItemId: 999 });
      expect(unknownCard.statusCode).toBe(404);
    });
  });

  it('needs a token', async () => {
    await withBoard(async (harness) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/moves',
        payload: MOVE,
      });

      expect(response.statusCode).toBe(401);
      expect(harness.ado.callCount).toBe(0);
      expect(harness.config.audits).toHaveLength(0);
    });
  });
});
