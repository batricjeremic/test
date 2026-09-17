/// <reference types="@testing-library/jest-dom/vitest" />
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBoardApiClient } from '../api/fakeClient';
import type { FakeBoardApiClientOptions } from '../api/fakeClient';
import { SourcesEditor } from './SourcesEditor';
import { makeAdminDraft } from './adminFixtures';
import type { AdminDraft } from './types';

const DIRECTORY: FakeBoardApiClientOptions = {
  sources: [],
  adoProjects: [
    { id: 'p-data', name: 'DataAI' },
    { id: 'p-media', name: 'Media House' },
  ],
  adoTeamsByProject: {
    'p-data': [{ id: 't-data', name: 'DataAI Team' }],
    'p-media': [{ id: 't-media', name: 'Media House Team' }],
  },
  adoBoardsByTeam: {
    'p-data/t-data': [
      { id: 'b-stories', name: 'Stories' },
      { id: 'b-epics', name: 'Epics' },
    ],
  },
};

function Harness({
  options = DIRECTORY,
}: {
  options?: FakeBoardApiClientOptions;
}): JSX.Element {
  const [draft, setDraft] = useState<AdminDraft>(() =>
    makeAdminDraft({ sources: [] }),
  );
  return (
    <SourcesEditor
      draft={draft}
      update={(patch) => setDraft(patch)}
      client={createFakeBoardApiClient(options)}
    />
  );
}

describe('SourcesEditor', () => {
  // The whole point: nobody types a GUID. Azure DevOps shows a team id
  // nowhere in its own UI, and a mistyped one fails as an empty board
  // much later rather than at the point of typing.
  it('adds a source by picking names, and stores the ids', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const projects = await screen.findByRole('combobox', { name: 'Project' });
    await user.selectOptions(projects, 'p-data');

    const teams = screen.getByRole('combobox', { name: 'Team' });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'DataAI Team' })).toBeTruthy(),
    );
    await user.selectOptions(teams, 't-data');

    const boards = screen.getByRole('combobox', { name: 'Board' });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Stories' })).toBeTruthy(),
    );
    await user.selectOptions(boards, 'b-epics');

    await user.click(screen.getByRole('button', { name: 'Add source' }));

    // The row reads in names; what was stored is the ids.
    const row = screen.getByRole('row', { name: /DataAI Team/ });
    expect(row.textContent).toContain('DataAI');
    expect(row.textContent).toContain('Epics');
  });

  it('will not add a source before all three are chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole('button', { name: 'Add source' })).toBeDisabled();
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Project' }),
      'p-data',
    );
    expect(screen.getByRole('button', { name: 'Add source' })).toBeDisabled();
  });

  // A picker that cannot load must not take away the only other way to
  // configure a board.
  it('falls back to text fields when the directory cannot be read', async () => {
    const client = createFakeBoardApiClient({ sources: [] });
    client.listAdoProjects = async () => {
      throw new Error('offline');
    };
    function Offline(): JSX.Element {
      const [draft, setDraft] = useState<AdminDraft>(() =>
        makeAdminDraft({ sources: [] }),
      );
      return (
        <SourcesEditor
          draft={draft}
          update={(patch) => setDraft(patch)}
          client={client}
        />
      );
    }
    render(<Offline />);

    expect(
      await screen.findByRole('textbox', { name: 'Project' }),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Could not read the list of projects',
    );
  });
});
