/// <reference types="@testing-library/jest-dom/vitest" />
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanonicalColumnsEditor } from './CanonicalColumnsEditor';
import { makeAdminDraft } from './adminFixtures';
import type { AdminDraft } from './types';

function Harness(): JSX.Element {
  const [draft, setDraft] = useState<AdminDraft>(() => makeAdminDraft());
  return (
    <CanonicalColumnsEditor draft={draft} update={(patch) => setDraft(patch)} />
  );
}

function columnNames(): (string | null)[] {
  return screen
    .getAllByRole('textbox', { name: /^Name of column/ })
    .map((input) => (input as HTMLInputElement).value);
}

describe('CanonicalColumnsEditor', () => {
  it('reorders a column from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(columnNames()).toEqual([
      'To do',
      'In progress',
      'In review',
      'Done',
    ]);

    const moveEarlier = screen.getByRole('button', {
      name: 'Move In progress earlier',
    });
    moveEarlier.focus();
    expect(moveEarlier).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(columnNames()).toEqual([
      'In progress',
      'To do',
      'In review',
      'Done',
    ]);
    expect(screen.getByTestId('column-order-status')).toHaveTextContent(
      'In progress is now column 1 of 4.',
    );

    // And the first column can no longer move up.
    expect(
      screen.getByRole('button', { name: 'Move In progress earlier' }),
    ).toBeDisabled();
  });

  it('adds a column and edits its state category', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('New column name'), 'Blocked');
    await user.click(screen.getByRole('button', { name: 'Add column' }));

    expect(columnNames()).toEqual([
      'To do',
      'In progress',
      'In review',
      'Done',
      'Blocked',
    ]);
    const category = screen.getByLabelText('State category of Blocked');
    await user.selectOptions(category, 'Proposed');
    expect(category).toHaveValue('Proposed');
  });
});
