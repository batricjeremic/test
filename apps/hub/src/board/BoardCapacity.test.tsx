/**
 * Capacity, where a user actually meets it: on the board.
 *
 * The capacity components were built as an island — correct, tested, and
 * rendered by nobody. These cases pin the wiring down, because the spec's
 * "done means" list includes seeing per-person capacity "in one bar", and
 * a bar no screen mounts ships nothing.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNASSIGNED_LANE_ID } from '@eg/shared';
import type { BoardSnapshot } from '@eg/shared';
import {
  ApiProvider,
  FIXTURE_BOARD_ID,
  createFakeBoardApiClient,
  makeBoardSnapshot,
  makePersonLoad,
  makeSwimlane,
  makeUnassignedSwimlane,
} from '../api';
import { HostProvider, createFakeHubHost } from '../sdk';
import { BoardProvider, ToastProvider, useFilters } from '../state';
import { BoardScreen } from './BoardScreen';

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
    </BoardProvider>
  );
}

async function renderBoard(
  overrides: Partial<BoardSnapshot> = {},
): Promise<void> {
  const client = createFakeBoardApiClient({
    snapshot: makeBoardSnapshot(overrides),
  });
  render(
    <ApiProvider client={client}>
      <HostProvider host={createFakeHubHost()}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </HostProvider>
    </ApiProvider>,
  );
  await screen.findByRole('grid');
}

function laneHeader(laneId: string): HTMLElement {
  const header = document.querySelector(`[data-lane-id="${laneId}"]`);
  if (!(header instanceof HTMLElement)) {
    throw new Error(`No lane header ${laneId}`);
  }
  return header;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('capacity on the board', () => {
  it('gives a person lane one bar with the rolled-up numbers', async () => {
    await renderBoard();

    const lane = laneHeader('lane-ana');
    expect(lane).toHaveTextContent('70%');
    expect(lane).toHaveTextContent('42 of 60 h');
    expect(
      within(lane).getByRole('img', { name: /Ana Ilic: 70% loaded/ }),
    ).toBeInTheDocument();
  });

  it('counts the cards without hours instead of hiding them', async () => {
    await renderBoard();

    // The fixture person carries six cards, one with no remaining work.
    expect(laneHeader('lane-ana')).toHaveTextContent(
      '6 cards, 1 without hours',
    );
  });

  it('marks a person who is over capacity', async () => {
    await renderBoard({
      personLoad: [
        makePersonLoad({ capacityHours: 30, committedHours: 42, load: 1.4 }),
      ],
    });

    expect(laneHeader('lane-ana')).toHaveTextContent('Over capacity');
  });

  it('draws no bar on the unassigned lane', async () => {
    await renderBoard();

    const lane = laneHeader(UNASSIGNED_LANE_ID);
    expect(within(lane).queryByRole('img')).not.toBeInTheDocument();
  });

  it('leaves a lane bare when that person has no load row', async () => {
    await renderBoard({
      swimlanes: [
        makeUnassignedSwimlane(),
        makeSwimlane({
          id: 'lane-milos',
          label: 'Milos Petrovic',
          personDescriptor: 'aad.milos',
          order: 2,
        }),
      ],
    });

    expect(
      within(laneHeader('lane-milos')).queryByRole('img'),
    ).not.toBeInTheDocument();
  });

  it('never shows a bar for somebody an override hides', async () => {
    await renderBoard({
      personLoad: [makePersonLoad({ hidden: true })],
    });

    expect(
      within(laneHeader('lane-ana')).queryByRole('img'),
    ).not.toBeInTheDocument();
  });

  it('opens the full capacity panel from the toolbar', async () => {
    await renderBoard();
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: 'Capacity' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('region', { name: 'Capacity this window' }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    const panel = await screen.findByRole('region', {
      name: 'Capacity this window',
    });
    expect(within(panel).getByText('Ana Ilic')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(
      screen.queryByRole('region', { name: 'Capacity this window' }),
    ).not.toBeInTheDocument();
  });

  it('shows the panel even when the board is grouped by team', async () => {
    await renderBoard({
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
    const user = userEvent.setup();

    // No person lanes exist here, so the panel is the only way to read
    // who is over — which is exactly why it is not lane-only.
    expect(
      within(laneHeader('lane-dev')).queryByRole('img'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Capacity' }));

    const panel = await screen.findByRole('region', {
      name: 'Capacity this window',
    });
    expect(within(panel).getByText('Ana Ilic')).toBeInTheDocument();
  });
});
