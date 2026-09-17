/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makePersonLoad } from '../api/fixtures';
import { CapacityPanel } from './CapacityPanel';

describe('CapacityPanel', () => {
  it('lists the heaviest person first and hides overridden people', () => {
    render(
      <CapacityPanel
        people={[
          makePersonLoad({
            descriptor: 'aad.ben',
            displayName: 'Ben Petrovic',
            load: 0.4,
          }),
          makePersonLoad({
            descriptor: 'aad.ana',
            displayName: 'Ana Ilic',
            capacityHours: 40,
            committedHours: 60,
            load: 1.5,
          }),
          makePersonLoad({
            descriptor: 'aad.svc',
            displayName: 'Build service',
            hidden: true,
          }),
        ]}
      />,
    );
    const names = screen
      .getAllByText(/Ana Ilic|Ben Petrovic|Build service/, {
        selector: '.eg-capacity__name',
      })
      .map((node) => node.textContent);
    expect(names).toEqual(['Ana Ilic', 'Ben Petrovic']);
  });

  it('footnotes people whose other teams are out of scope', () => {
    render(
      <CapacityPanel people={[makePersonLoad({ outOfScopeTeamCount: 2 })]} />,
    );
    expect(screen.getByText('2 teams out of scope')).toBeInTheDocument();
    expect(
      screen.getByText(/1 person is also on teams outside this board/),
    ).toBeInTheDocument();
  });

  it('says so when nobody is in scope', () => {
    render(<CapacityPanel people={[]} />);
    expect(
      screen.getByText(/Nobody in this board’s scope has work/),
    ).toBeInTheDocument();
  });
});
