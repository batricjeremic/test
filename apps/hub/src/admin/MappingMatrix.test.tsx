/// <reference types="@testing-library/jest-dom/vitest" />
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MappingMatrix } from './MappingMatrix';
import { buildAdminTeams, namingFromSnapshot } from './model';
import { makeAdminDraft, makeAdminSnapshot } from './adminFixtures';
import type { AdminDraft } from './types';

function Harness(): JSX.Element {
  const [draft, setDraft] = useState<AdminDraft>(() => makeAdminDraft());
  const snapshot = makeAdminSnapshot();
  const teams = buildAdminTeams(
    draft.sources,
    draft.mappings,
    snapshot.unmappedColumns,
    namingFromSnapshot(snapshot),
  );
  return (
    <MappingMatrix
      draft={draft}
      teams={teams}
      update={(patch) => setDraft(patch)}
      addTeamColumn={() => undefined}
    />
  );
}

describe('MappingMatrix', () => {
  it("renders a team's own columns against the canonical ones", () => {
    render(<Harness />);

    for (const name of ['To do', 'In progress', 'In review', 'Done']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Delivery · Dev')).toBeInTheDocument();
    expect(screen.getByText('Data and AI · Data and AI')).toBeInTheDocument();

    // Dev's "In Review" is mapped; Data and AI's identically named column
    // is not, which is the whole reason this screen is a matrix.
    expect(
      screen.getByRole('radio', { name: 'Map In Review on Dev to In review' }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', {
        name: 'Leave In Review on Data and AI unmapped',
      }),
    ).toBeChecked();
  });

  it('maps an unmapped column and then accepts a target state', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const targetState = screen.getByLabelText(
      'Target state for In Review on Data and AI',
    );
    expect(targetState).toBeDisabled();
    expect(targetState).toHaveAttribute('placeholder', 'Column moves alone');

    await user.click(
      screen.getByRole('radio', {
        name: 'Map In Review on Data and AI to In review',
      }),
    );
    expect(
      screen.getByRole('radio', {
        name: 'Map In Review on Data and AI to In review',
      }),
    ).toBeChecked();

    const enabled = screen.getByLabelText(
      'Target state for In Review on Data and AI',
    );
    expect(enabled).toBeEnabled();
    await user.type(enabled, 'Code Review');
    expect(enabled).toHaveValue('Code Review');
  });
});

/**
 * The live board showed a nameless row carrying 27 cards on one team and
 * 72 on another. Those are work items in the sprint that are not on the
 * team's board at all — Bugs and Tasks, when the team keeps bugs at task
 * level — so they have no column, and a row offering to map "" was both
 * meaningless and the biggest number on the screen.
 */
describe('cards that are not on the team board', () => {
  it('counts them instead of offering a nameless row to map', () => {
    const teams = buildAdminTeams(
      [
        {
          boardId: 'board-1',
          projectId: 'p-data',
          teamId: 't-data',
          backlogLevel: 'b-stories',
        },
      ],
      [],
      [
        {
          projectId: 'p-data',
          teamId: 't-data',
          teamName: 'DataAI Team',
          sourceColumn: '',
          cardCount: 27,
        },
        {
          projectId: 'p-data',
          teamId: 't-data',
          teamName: 'DataAI Team',
          sourceColumn: 'Active',
          cardCount: 3,
        },
      ],
      new Map(),
    );

    expect(teams).toHaveLength(1);
    expect(teams[0]?.cardsWithNoColumn).toBe(27);
    expect(teams[0]?.columns.map((column) => column.sourceColumnId)).toEqual([
      'Active',
    ]);
  });
});
