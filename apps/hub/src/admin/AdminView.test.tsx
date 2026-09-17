/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnMapping } from '@eg/shared';
import { ApiClientError, ApiProvider, createFakeBoardApiClient } from '../api';
import type { BoardApiClient } from '../api';
import { FIXTURE_COLUMNS } from '../api/fixtures';
import { AdminView } from './AdminView';
import {
  ADMIN_FIXTURE_DEFINITION,
  ADMIN_FIXTURE_MAPPINGS,
  ADMIN_FIXTURE_OVERRIDES,
  ADMIN_FIXTURE_SOURCES,
  makeAdminSnapshot,
} from './adminFixtures';

function makeClient(): ReturnType<typeof createFakeBoardApiClient> {
  return createFakeBoardApiClient({
    snapshot: makeAdminSnapshot(),
    definitions: [ADMIN_FIXTURE_DEFINITION],
    sources: ADMIN_FIXTURE_SOURCES,
    columns: FIXTURE_COLUMNS,
    mappings: ADMIN_FIXTURE_MAPPINGS,
    personOverrides: ADMIN_FIXTURE_OVERRIDES,
  });
}

function renderAdmin(client: BoardApiClient): void {
  render(
    <ApiProvider client={client}>
      <AdminView />
    </ApiProvider>,
  );
}

async function mapDataAndAiReview(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(
    await screen.findByRole('radio', {
      name: 'Map In Review on Data and AI to In review',
    }),
  );
  await user.type(
    screen.getByLabelText('Target state for In Review on Data and AI'),
    'Code Review',
  );
}

describe('AdminView', () => {
  it('counts and lists every unmapped team column', async () => {
    renderAdmin(makeClient());

    expect(await screen.findByTestId('unmapped-count')).toHaveTextContent('1');
    expect(
      screen.getByText(/1 team column has no mapping row/),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 cards are there right now/)).toBeInTheDocument();

    const entry = screen
      .getAllByRole('listitem')
      .find((node) => node.textContent?.includes('Data and AI'));
    expect(entry?.textContent).toContain('In Review');
    expect(entry?.textContent).toContain('3 cards stranded');
  });

  it('round-trips a mapping with a target state and reports what changed', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderAdmin(client);

    await mapDataAndAiReview(user);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(async () => {
      const saved: ColumnMapping[] = await client.listColumnMappings('any');
      expect(
        saved.find(
          (mapping) =>
            mapping.teamId === 'team-data' &&
            mapping.sourceColumnId === 'In Review',
        ),
      ).toEqual({
        boardId: ADMIN_FIXTURE_DEFINITION.id,
        teamId: 'team-data',
        sourceColumnId: 'In Review',
        canonicalColumnId: 'col-review',
        targetState: 'Code Review',
      });
    });

    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mapped In Review to "In review", also writing the state Code Review.',
      ),
    ).toBeInTheDocument();
    // Nothing is left unmapped, which is the point of the screen.
    expect(screen.getByTestId('unmapped-count')).toHaveTextContent('0');
  });

  it('surfaces a failed save and keeps the edit on screen', async () => {
    const user = userEvent.setup();
    const fake = makeClient();
    const client: BoardApiClient = {
      ...fake,
      replaceColumnMappings: async () => {
        throw new ApiClientError({
          kind: 'http',
          status: 409,
          message: 'Conflict',
          traceId: 'trace-test',
          apiError: {
            code: 'mapping-conflict',
            message: 'Somebody else changed this mapping.',
            status: 409,
            traceId: 'trace-test',
          },
        });
      },
    };
    renderAdmin(client);

    await mapDataAndAiReview(user);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Somebody else changed this mapping.');
    expect(alert).toHaveTextContent(/Your changes are still on this screen/);
    expect(
      screen.getByLabelText('Target state for In Review on Data and AI'),
    ).toHaveValue('Code Review');
  });
});
