import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  DEFAULT_ITERATION_ALIGNMENT,
  EMPTY_BOARD_FILTER_SET,
} from '@eg/shared';
import type { BoardFilterSet } from '@eg/shared';
import {
  ApiClientError,
  ApiProvider,
  createFakeBoardApiClient,
  FIXTURE_BOARD_ID,
  makeBoardCard,
  makeBoardSnapshot,
} from '../api';
import type { FakeBoardApiClient } from '../api';
import { useBoard } from './useBoard';

function renderBoard(
  client: FakeBoardApiClient,
  filters: BoardFilterSet = EMPTY_BOARD_FILTER_SET,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider client={client}>{children}</ApiProvider>
  );
  return renderHook(
    (props: { filters: BoardFilterSet }) =>
      useBoard(FIXTURE_BOARD_ID, DEFAULT_ITERATION_ALIGNMENT, props.filters, {
        realtime: false,
      }),
    { wrapper, initialProps: { filters } },
  );
}

describe('useBoard', () => {
  it('loads the snapshot and exposes the board', async () => {
    const client = createFakeBoardApiClient();
    const { result } = renderBoard(client);

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.data?.boardId).toBe(FIXTURE_BOARD_ID);
    expect(result.current.cards).toHaveLength(2);
    expect(result.current.columns).toHaveLength(4);
    expect(result.current.swimlanes).toHaveLength(2);
    expect(result.current.permissions?.canAdminister).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a load failure as a readable message', async () => {
    const client = createFakeBoardApiClient();
    client.failNextSnapshot(
      new ApiClientError({
        kind: 'network',
        message: 'boom',
        traceId: 'trace-1',
      }),
    );
    const { result } = renderBoard(client);

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe(
      'The board service could not be reached.',
    );
  });

  it('reloads when the filters change', async () => {
    const client = createFakeBoardApiClient();
    const { result, rerender } = renderBoard(client);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(client.snapshotRequests).toHaveLength(1);

    rerender({
      filters: { ...EMPTY_BOARD_FILTER_SET, workItemTypes: ['Bug'] },
    });

    await waitFor(() => {
      expect(client.snapshotRequests).toHaveLength(2);
    });
    expect(client.snapshotRequests[1]?.query.filters.workItemTypes).toEqual([
      'Bug',
    ]);
  });

  it('refetches on demand', async () => {
    const client = createFakeBoardApiClient();
    const { result } = renderBoard(client);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    client.setSnapshot(
      makeBoardSnapshot({
        cards: [makeBoardCard({ workItemId: 2001, title: 'Fresh' })],
      }),
    );
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.cards.map((card) => card.workItemId)).toEqual([2001]);
  });

  it('applies a card-moved delta to the board', async () => {
    const client = createFakeBoardApiClient();
    const { result } = renderBoard(client);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.applyDelta({
        kind: 'card-moved',
        workItemId: 1001,
        rev: 12,
        fromCanonicalColumnId: 'col-doing',
        toCanonicalColumnId: 'col-done',
        sourceColumn: 'Done',
        state: 'Closed',
        assignedTo: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
      });
    });

    const card = result.current.cardsById.get(1001);
    expect(card?.canonicalColumnId).toBe('col-done');
    expect(card?.rev).toBe(12);
    expect(card?.state).toBe('Closed');
  });

  it('applies upsert and removal deltas', async () => {
    const client = createFakeBoardApiClient();
    const { result } = renderBoard(client);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.applyDelta({
        kind: 'card-upserted',
        card: makeBoardCard({ workItemId: 3001, title: 'New arrival' }),
      });
      result.current.applyDelta({
        kind: 'card-removed',
        workItemId: 1002,
        cause: 'iteration-changed',
      });
    });

    const ids = result.current.cards.map((card) => card.workItemId);
    expect(ids).toEqual([1001, 3001]);
  });

  it('reports the realtime status so degraded mode can be shown', async () => {
    const client = createFakeBoardApiClient();
    const { result } = renderBoard(client);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Realtime is off in this harness, so the board must say so rather
    // than pretending to be live.
    expect(result.current.realtime.degraded).toBe(true);
    expect(result.current.realtime.label).toBe('Live updates off');
  });
});
