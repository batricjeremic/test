/**
 * The board, rendered against a fake BFF.
 *
 * The cases are the promises the spec makes to a user: the unassigned
 * lane is pinned and never hidden, an unmapped column names the team and
 * the column rather than guessing, a card nobody may write is not a drag
 * source, a refused drop never reaches the network, an accepted one
 * carries the rev the user was looking at, and every failure puts the
 * card back and says why.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEndEvent } from '@dnd-kit/core';
import { UNASSIGNED_LANE_ID, UNMAPPED_COLUMN_ID } from '@eg/shared';
import type {
  BoardCard,
  BoardSnapshot,
  BoardTeamView,
  MoveFailure,
} from '@eg/shared';
import {
  ApiProvider,
  FIXTURE_BOARD_ID,
  createFakeBoardApiClient,
  makeBoardCard,
  makeBoardSnapshot,
  makeBoardTeamView,
  makeSwimlane,
  makeTeamIterationWindow,
  makeUnassignedSwimlane,
} from '../api';
import type { FakeBoardApiClient } from '../api';
import { HostProvider, createFakeHubHost } from '../sdk';
import {
  BoardProvider,
  ToastProvider,
  buildCardDragData,
  useBoardContext,
  useFilters,
} from '../state';
import type { ColumnDropData } from '../types';
import { BoardScreen } from './BoardScreen';
import { buildColumnList } from './layout';
import { useBoardDnd } from './useBoardDnd';
import type { BoardDnd } from './useBoardDnd';

/**
 * The board's own drag handlers, captured from a second instance of the
 * same hook: a synthetic pointer drag in jsdom measures nothing, so the
 * drop path is driven directly while the pick-up path is driven from the
 * keyboard through the real sensor.
 */
let dnd: BoardDnd | null = null;

function DndCapture(): null {
  const board = useBoardContext();
  const columns = buildColumnList(
    board.boardId,
    board.columns,
    board.cards,
    board.unmappedColumns,
  );
  dnd = useBoardDnd({ columns, teams: board.teams });
  return null;
}

function Harness(): JSX.Element {
  const filters = useFilters();
  return (
    <BoardProvider
      boardId={FIXTURE_BOARD_ID}
      alignment={filters.alignment}
      filters={filters.filters}
      grouping={filters.grouping}
      options={{ realtime: false }}
    >
      <BoardScreen filters={filters} />
      <DndCapture />
    </BoardProvider>
  );
}

/** The fake host of the most recent render, for tests that assert on it. */
let host: ReturnType<typeof createFakeHubHost> | null = null;

async function renderBoard(
  client: FakeBoardApiClient = createFakeBoardApiClient(),
): Promise<FakeBoardApiClient> {
  host = createFakeHubHost();
  render(
    <ApiProvider client={client}>
      <HostProvider host={host}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </HostProvider>
    </ApiProvider>,
  );
  await screen.findByRole('grid');
  return client;
}

function cardElement(workItemId: number): HTMLElement {
  const element = document.querySelector(`[data-work-item-id="${workItemId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Card ${workItemId} is not on the board`);
  }
  return element;
}

/** The column a card is currently rendered in, read off the cell. */
function columnOf(workItemId: number): string {
  const cell = cardElement(workItemId).closest('[role="gridcell"]');
  const label = cell?.getAttribute('aria-label') ?? '';
  return label.split(', ')[1] ?? '';
}

function cellFor(laneLabel: string, columnName: string): HTMLElement {
  const cell = screen
    .getAllByRole('gridcell')
    .find((candidate) =>
      (candidate.getAttribute('aria-label') ?? '').startsWith(
        `${laneLabel}, ${columnName}, `,
      ),
    );
  if (cell === undefined) {
    throw new Error(`No cell for ${laneLabel} / ${columnName}`);
  }
  return cell;
}

function laneHeader(laneId: string): HTMLElement {
  const header = document.querySelector(`[data-lane-id="${laneId}"]`);
  if (!(header instanceof HTMLElement)) {
    throw new Error(`No lane header ${laneId}`);
  }
  return header;
}

/** A drop, as @dnd-kit would report it once the pointer is released. */
async function drop(
  card: BoardCard,
  team: BoardTeamView | null,
  laneId: string,
  toCanonicalColumnId: string,
  toLaneId: string = laneId,
): Promise<void> {
  const active = buildCardDragData(card, team, laneId);
  const over: ColumnDropData = {
    kind: 'column',
    canonicalColumnId: toCanonicalColumnId,
    swimlaneId: toLaneId,
  };
  const event = {
    active: { id: `card:${card.workItemId}`, data: { current: active } },
    over: { id: 'cell', data: { current: over } },
  } as unknown as DragEndEvent;

  await act(async () => {
    dnd?.onDragEnd(event);
  });
}

const anaLane = makeSwimlane({
  id: 'lane-ana',
  label: 'Ana Ilic',
  personDescriptor: 'aad.ana',
  order: 1,
  cardCount: 2,
  remainingWorkHours: 8,
});

const dataTeam = makeBoardTeamView({
  projectId: 'Data and AI',
  teamId: 'team-data',
  iteration: makeTeamIterationWindow({
    projectId: 'Data and AI',
    projectName: 'Data and AI',
    teamId: 'team-data',
    teamName: 'Data and AI',
    iterationId: 'iteration-data-8',
    iterationName: 'Sprint 8',
    workingDaysTotal: 10,
    workingDaysElapsed: 8,
  }),
});

beforeEach(() => {
  dnd = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

describe('BoardScreen', () => {
  it('renders canonical columns in order with a count each', async () => {
    await renderBoard();

    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual([
      'Person',
      'To do1',
      'In progress1',
      'In review0',
      'Done0',
    ]);
  });

  it('pins the unassigned lane at the top and never hides it', async () => {
    const snapshot = makeBoardSnapshot({
      swimlanes: [anaLane, { ...makeUnassignedSwimlane(), order: 9 }],
      cards: [
        makeBoardCard(),
        makeBoardCard({
          workItemId: 1003,
          title: 'Nobody owns this yet',
          assignedTo: null,
          canonicalColumnId: 'col-todo',
        }),
      ],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));

    const laneLabels = screen
      .getAllByRole('rowheader')
      .map((header) => header.getAttribute('data-lane-id'));
    expect(laneLabels[0]).toBe(UNASSIGNED_LANE_ID);
    expect(columnOf(1003)).toBe('To do');
  });

  it('shows a trimmed lane with its hidden count rather than dropping it', async () => {
    const snapshot = makeBoardSnapshot({
      swimlanes: [
        makeUnassignedSwimlane(),
        makeSwimlane({
          id: 'lane-milos',
          label: 'Milos Petrovic',
          personDescriptor: 'aad.milos',
          order: 2,
          cardCount: 0,
          hiddenCardCount: 3,
          remainingWorkHours: 0,
        }),
        anaLane,
      ],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));

    expect(laneHeader('lane-milos')).toHaveTextContent(
      '3 cards hidden by permissions',
    );
  });

  it('names the team and the column that has no mapping row', async () => {
    const snapshot = makeBoardSnapshot({
      teams: [makeBoardTeamView(), dataTeam],
      unmappedColumns: [
        {
          projectId: 'Data and AI',
          teamId: 'team-data',
          teamName: 'Data and AI',
          sourceColumn: 'In Review',
          cardCount: 1,
        },
      ],
      cards: [
        makeBoardCard(),
        makeBoardCard({
          workItemId: 1009,
          title: 'Stranded by a missing mapping',
          teamId: 'team-data',
          project: 'Data and AI',
          iterationId: 'iteration-data-8',
          sourceColumn: 'In Review',
          canonicalColumnId: UNMAPPED_COLUMN_ID,
        }),
      ],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));

    const notice = screen.getByRole('region', { name: 'Unmapped columns' });
    expect(notice).toHaveTextContent('Data and AI');
    expect(notice).toHaveTextContent('In Review');

    expect(columnOf(1009)).toBe('Unmapped');
    expect(cardElement(1009)).toHaveTextContent(
      'Data and AI column “In Review” is not mapped',
    );
  });

  it('shows each team its own sprint dates when cadences differ', async () => {
    const snapshot = makeBoardSnapshot({
      grouping: 'team',
      swimlanes: [
        makeUnassignedSwimlane(),
        makeSwimlane({
          id: 'lane-dev',
          kind: 'team',
          label: 'Dev',
          personDescriptor: null,
          teamId: 'team-dev',
          order: 1,
        }),
      ],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));

    expect(laneHeader('lane-dev')).toHaveTextContent('day 2 of 10');
  });

  it('does not make a card from a read-only project draggable', async () => {
    const snapshot = makeBoardSnapshot({
      teams: [makeBoardTeamView({ writable: false })],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));

    const card = cardElement(1001);
    expect(card).toHaveAttribute('data-draggable', 'false');
    expect(card).toHaveAttribute('data-state', 'read-only');
    expect(card).not.toHaveAttribute('role', 'button');
    expect(laneHeader('lane-ana')).toHaveAttribute('data-readonly', 'true');
  });

  it('refuses a drop on an unmapped column before any request is sent', async () => {
    const snapshot = makeBoardSnapshot({
      teams: [
        makeBoardTeamView({
          mappedCanonicalColumnIds: ['col-todo', 'col-doing'],
        }),
      ],
    });
    const client = await renderBoard(createFakeBoardApiClient({ snapshot }));
    const board = client.getSnapshot();
    const card = board.cards[0] as BoardCard;

    await drop(card, board.teams[0] ?? null, 'lane-ana', 'col-review');

    expect(client.moveRequests).toHaveLength(0);
    expect(columnOf(1001)).toBe('In progress');
    expect(
      await screen.findByText('That column is not mapped for this team'),
    ).toBeInTheDocument();
  });

  it('blocks the unmapped column for that card from drag start', async () => {
    const snapshot = makeBoardSnapshot({
      teams: [
        makeBoardTeamView({
          mappedCanonicalColumnIds: ['col-todo', 'col-doing'],
        }),
      ],
    });
    await renderBoard(createFakeBoardApiClient({ snapshot }));
    const user = userEvent.setup();

    cardElement(1001).focus();
    await user.keyboard('[Space]');

    await waitFor(() => {
      expect(cellFor('Ana Ilic', 'In review')).toHaveAttribute(
        'data-drop',
        'blocked',
      );
    });
    expect(cellFor('Ana Ilic', 'To do')).not.toHaveAttribute('data-drop');

    await user.keyboard('[Escape]');
  });

  it('sends the move with the rev the user was looking at', async () => {
    const client = await renderBoard();
    const board = client.getSnapshot();
    const card = board.cards[0] as BoardCard;
    expect(card.rev).toBe(7);

    await drop(card, board.teams[0] ?? null, 'lane-ana', 'col-review');

    await waitFor(() => {
      expect(client.moveRequests).toHaveLength(1);
    });
    expect(client.moveRequests[0]).toEqual({
      boardId: FIXTURE_BOARD_ID,
      workItemId: 1001,
      rev: 7,
      fromCanonicalColumnId: 'col-doing',
      toCanonicalColumnId: 'col-review',
    });
    await waitFor(() => {
      expect(columnOf(1001)).toBe('In review');
    });
  });

  it('never writes a lane change: a cross-lane drop is refused', async () => {
    const snapshot = makeBoardSnapshot({
      swimlanes: [
        makeUnassignedSwimlane(),
        anaLane,
        makeSwimlane({
          id: 'lane-milos',
          label: 'Milos Petrovic',
          personDescriptor: 'aad.milos',
          order: 2,
          cardCount: 0,
          remainingWorkHours: 0,
        }),
      ],
    });
    const client = await renderBoard(createFakeBoardApiClient({ snapshot }));
    const board = client.getSnapshot();
    const card = board.cards[0] as BoardCard;

    await drop(
      card,
      board.teams[0] ?? null,
      'lane-ana',
      'col-review',
      'lane-milos',
    );

    expect(client.moveRequests).toHaveLength(0);
    expect(columnOf(1001)).toBe('In progress');
  });

  it('locks the card with a spinner while the write is in flight', async () => {
    const client = await renderBoard();
    const board = client.getSnapshot();
    const card = board.cards[0] as BoardCard;
    const deferred = client.deferNextMove();

    await drop(card, board.teams[0] ?? null, 'lane-ana', 'col-review');
    await deferred.sent;

    await waitFor(() => {
      expect(cardElement(1001)).toHaveAttribute('data-state', 'saving');
    });
    expect(
      within(cardElement(1001)).getByRole('status', { name: 'Saving' }),
    ).toBeInTheDocument();
    expect(cardElement(1001)).toHaveAttribute('data-draggable', 'false');

    await act(async () => {
      deferred.resolve({
        status: 'applied',
        workItemId: 1001,
        card: { ...card, canonicalColumnId: 'col-review', rev: 8 },
        stateChanged: false,
      });
    });

    await waitFor(() => {
      expect(cardElement(1001)).toHaveAttribute('data-state', 'idle');
    });
  });
});

describe('BoardScreen failures', () => {
  const revisionConflict: MoveFailure = {
    reason: 'revision-conflict',
    message: 'Ana moved this to Done a moment ago',
    currentRev: 9,
    currentCanonicalColumnId: 'col-done',
    currentColumnName: 'Done',
    changedBy: { descriptor: 'aad.ana', displayName: 'Ana Ilic' },
    changedAt: '2026-09-17T09:00:00.000Z',
  };

  async function failWith(
    failure: MoveFailure,
    snapshot?: BoardSnapshot,
  ): Promise<FakeBoardApiClient> {
    const client = await renderBoard(
      createFakeBoardApiClient(snapshot === undefined ? {} : { snapshot }),
    );
    const board = client.getSnapshot();
    const card = board.cards[0] as BoardCard;
    client.failNextMove(failure);
    await drop(card, board.teams[0] ?? null, 'lane-ana', 'col-review');
    return client;
  }

  it('rolls the card back and says who moved it, on a conflict', async () => {
    await failWith(revisionConflict);

    expect(
      await screen.findByText('Ana moved this to Done a moment ago'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(columnOf(1001)).toBe('In progress');
    });
  });

  it('names the field and offers the work item form on a rule violation', async () => {
    await failWith({
      reason: 'rule-violation',
      message: 'Activity is required before this can move to Active',
      field: 'Microsoft.VSTS.Common.Activity',
      fieldDisplayName: 'Activity',
      targetState: 'Active',
      workItemUrl: 'https://dev.azure.com/expertgroup/Delivery/_workitems/1001',
    });

    expect(await screen.findByText('Activity is required')).toBeInTheDocument();
    const action = screen.getByRole('link', { name: 'Open work item' });
    expect(action).toHaveAttribute(
      'href',
      'https://dev.azure.com/expertgroup/Delivery/_workitems/1001',
    );
    expect(columnOf(1001)).toBe('In progress');
  });

  it('names the allowed next states on a forbidden transition', async () => {
    await failWith({
      reason: 'transition-not-allowed',
      message: '',
      fromState: 'Active',
      toState: 'Closed',
      allowedStates: ['Resolved', 'Removed'],
    });

    expect(
      await screen.findByText(/Allowed from here: Resolved or Removed/),
    ).toBeInTheDocument();
    expect(columnOf(1001)).toBe('In progress');
  });

  it('says the service is busy when Azure DevOps throttles', async () => {
    await failWith({
      reason: 'service-unavailable',
      message: '',
      attempts: 3,
      retryAfterSeconds: 12,
    });

    expect(await screen.findByText('Azure DevOps is busy')).toBeInTheDocument();
    expect(screen.getByText(/Try again in 12s/)).toBeInTheDocument();
    expect(columnOf(1001)).toBe('In progress');
  });
});

describe('BoardScreen filters and detail', () => {
  it('drives a refetch through the URL-backed filter set', async () => {
    const client = await renderBoard();
    const user = userEvent.setup();

    await user.click(screen.getByLabelText('Unassigned only'));

    await waitFor(() => {
      expect(client.snapshotRequests.length).toBeGreaterThan(1);
    });
    expect(client.snapshotRequests.at(-1)?.query.filters.unassignedOnly).toBe(
      true,
    );
    expect(window.location.search).toContain('unassigned=1');
  });

  // The detail used to be a dialog framing dev.azure.com, which Azure
  // DevOps refuses outright — it rendered "refused to connect" and
  // nothing else. It is now a drawer of what the board already knows,
  // and editing hands off to the host's own form.
  it('opens a drawer and hands editing to the native form', async () => {
    await renderBoard();
    const user = userEvent.setup();

    await user.click(
      screen.getByRole('button', { name: 'Wire the hub to the BFF' }),
    );

    const drawer = await screen.findByRole('dialog');
    expect(drawer).toHaveAccessibleName(
      'User Story 1001: Wire the hub to the BFF',
    );
    expect(
      within(drawer).getByRole('link', { name: 'Open in a new tab' }),
    ).toHaveAttribute(
      'href',
      'https://dev.azure.com/expertgroup/Delivery/_workitems/edit/1001',
    );

    await user.click(
      within(drawer).getByRole('button', { name: 'Edit in Azure DevOps' }),
    );
    await waitFor(() => {
      expect(host?.openedWorkItems).toEqual([1001]);
    });

    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('surfaces a load failure with a way back', async () => {
    const client = createFakeBoardApiClient();
    client.failNextSnapshot(new Error('the BFF is down'));
    render(
      <ApiProvider client={client}>
        <HostProvider host={createFakeHubHost()}>
          <ToastProvider>
            <Harness />
          </ToastProvider>
        </HostProvider>
      </ApiProvider>,
    );

    expect(
      await screen.findByText('The board could not be loaded'),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
  });
});

describe('keyboard access', () => {
  it('makes every writable card a keyboard drag source', async () => {
    await renderBoard();
    const card = cardElement(1001);
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('aria-roledescription', 'draggable');
  });

  it('announces a keyboard pick-up in a live region', async () => {
    await renderBoard();
    const user = userEvent.setup();

    cardElement(1001).focus();
    await user.keyboard('[Space]');

    const liveRegion = document.querySelector('[id^="DndLiveRegion"]');
    await waitFor(() => {
      expect(liveRegion?.textContent ?? '').not.toBe('');
    });

    // The wording itself is a pure function of the board, so it is
    // asserted directly rather than raced against the next announcement.
    const active = buildCardDragData(
      makeBoardCard(),
      makeBoardTeamView(),
      'lane-ana',
    );
    expect(
      dnd?.announcements.onDragStart({
        active: { id: 'card:1001', data: { current: active } },
      } as never),
    ).toMatch(/Picked up User Story 1001, Wire the hub to the BFF/);

    await user.keyboard('[Escape]');
  });

  // A board with thirty people is read one lane at a time; collapsing
  // thirty headers by hand to find the two that matter is not something
  // anyone does twice.
  it('collapses and expands every lane from one control', async () => {
    const user = userEvent.setup();
    await renderBoard();

    const toggle = await screen.findByRole('button', { name: 'Collapse all' });
    await user.click(toggle);

    expect(
      screen.getByRole('button', { name: 'Expand all' }),
    ).toBeInTheDocument();
    for (const lane of screen.getAllByRole('rowheader')) {
      expect(lane.getAttribute('data-collapsed')).toBe('true');
    }

    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    for (const lane of screen.getAllByRole('rowheader')) {
      expect(lane.getAttribute('data-collapsed')).toBe('false');
    }
  });
});

// The fake host is deterministic; nothing here should reach a real clock.
vi.setConfig({ testTimeout: 10_000 });
