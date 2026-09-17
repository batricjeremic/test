/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makePersonLoad } from '../api/fixtures';
import { PersonCapacity } from './PersonCapacity';

describe('PersonCapacity', () => {
  it('shows a number and a marker, not colour alone, when over', () => {
    render(
      <PersonCapacity
        person={makePersonLoad({
          capacityHours: 40,
          committedHours: 60,
          load: 1.5,
        })}
      />,
    );
    expect(screen.getByText('150%')).toBeInTheDocument();
    expect(screen.getByText('Over capacity')).toBeInTheDocument();
    expect(screen.getByText('60 of 40 h')).toBeInTheDocument();
    const bar = screen.getByRole('img');
    expect(bar).toHaveAttribute('data-over', 'true');
    expect(bar.getAttribute('aria-label')).toContain('150% loaded');
  });

  it('marks partial capacity rather than looking under-loaded', () => {
    const base = makePersonLoad({ partialCapacity: true });
    const team = base.perTeam[0];
    if (!team) throw new Error('fixture must have a team');
    render(
      <PersonCapacity
        person={{
          ...base,
          perTeam: [
            team,
            {
              ...team,
              teamId: 'team-data',
              teamName: 'Data and AI',
              hasCapacityRecord: false,
              capacityPerDay: 0,
              capacityHours: 0,
              committedHours: 8,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('Partial capacity')).toBeInTheDocument();
  });

  it('renders zero capacity as an empty bar, never a full one', () => {
    render(
      <PersonCapacity
        person={makePersonLoad({
          capacityHours: 0,
          committedHours: 9,
          load: null,
        })}
      />,
    );
    expect(
      screen.getByText('No capacity', { selector: '.eg-capacity__load' }),
    ).toBeInTheDocument();
    const bar = screen.getByRole('img');
    expect(bar).toHaveAttribute('data-unknown', 'true');
    expect(bar.style.getPropertyValue('--eg-bar-value')).toBe('0%');
    expect(screen.getByText('9 h committed')).toBeInTheDocument();
  });

  it('shows card count and hours-free cards side by side in a lane', () => {
    render(
      <PersonCapacity
        variant="lane"
        person={makePersonLoad({ cardCount: 6, cardsWithoutRemainingWork: 2 })}
      />,
    );
    expect(screen.getByText('6 cards, 2 without hours')).toBeInTheDocument();
    expect(screen.getByText('2 without hours')).toBeInTheDocument();
  });

  it('reaches the per-team split with the keyboard', async () => {
    const user = userEvent.setup();
    const base = makePersonLoad();
    const team = base.perTeam[0];
    if (!team) throw new Error('fixture must have a team');
    render(
      <PersonCapacity
        person={{
          ...base,
          perTeam: [
            team,
            { ...team, teamId: 'team-data', teamName: 'Data and AI' },
          ],
        }}
      />,
    );

    const trigger = screen.getByRole('button', { name: /per-team split/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('group', { name: /per-team split for/i }),
    ).toBeNull();

    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const panel = screen.getByRole('group', { name: /per-team split for/i });
    expect(panel).toBeVisible();
    expect(
      screen.getByRole('rowheader', { name: /Data and AI/ }),
    ).toBeVisible();
  });
});
