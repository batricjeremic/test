import { describe, expect, it } from 'vitest';
import {
  buildAreaPathIndex,
  normalizeAreaPath,
  resolveOwningTeamId,
  teamAreaPathsFrom,
} from './area-paths.js';

const index = buildAreaPathIndex([
  {
    projectId: 'Delivery',
    teamId: 'team-web',
    areaPaths: [{ value: 'Delivery\\Web', includeChildren: true }],
  },
  {
    projectId: 'Delivery',
    teamId: 'team-checkout',
    areaPaths: [{ value: 'Delivery\\Web\\Checkout', includeChildren: true }],
  },
  {
    projectId: 'Delivery',
    teamId: 'team-platform',
    areaPaths: [{ value: 'Delivery\\Platform', includeChildren: false }],
  },
  {
    projectId: 'Data',
    teamId: 'team-data',
    areaPaths: [{ value: 'Data', includeChildren: true }],
  },
]);

describe('normalizeAreaPath', () => {
  it.each([
    ['Delivery\\Web', 'delivery\\web'],
    ['Delivery/Web/', 'delivery\\web'],
    ['  \\Delivery\\\\Web\\ ', 'delivery\\web'],
    ['DELIVERY\\WEB', 'delivery\\web'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeAreaPath(input)).toBe(expected);
  });
});

describe('resolveOwningTeamId', () => {
  it('resolves an exact subscription', () => {
    expect(resolveOwningTeamId(index, 'Delivery', 'Delivery\\Platform')).toBe(
      'team-platform',
    );
  });

  it('resolves a child path to the subscribing parent', () => {
    expect(
      resolveOwningTeamId(index, 'Delivery', 'Delivery\\Web\\Search\\Ranking'),
    ).toBe('team-web');
  });

  it('gives a child path to the most specific team that claims it', () => {
    expect(
      resolveOwningTeamId(index, 'Delivery', 'Delivery\\Web\\Checkout\\Basket'),
    ).toBe('team-checkout');
  });

  it('prefers an exact subscription over an inherited one', () => {
    const contested = buildAreaPathIndex([
      {
        projectId: 'Delivery',
        teamId: 'team-parent',
        areaPaths: [
          { value: 'Delivery\\Web\\Checkout', includeChildren: true },
        ],
      },
      {
        projectId: 'Delivery',
        teamId: 'team-exact',
        areaPaths: [
          { value: 'Delivery\\Web\\Checkout\\Basket', includeChildren: false },
        ],
      },
    ]);
    expect(
      resolveOwningTeamId(
        contested,
        'Delivery',
        'Delivery\\Web\\Checkout\\Basket',
      ),
    ).toBe('team-exact');
  });

  it('does not inherit when includeChildren is false', () => {
    expect(
      resolveOwningTeamId(index, 'Delivery', 'Delivery\\Platform\\Runtime'),
    ).toBeNull();
  });

  it('never crosses a project boundary', () => {
    expect(resolveOwningTeamId(index, 'Data', 'Delivery\\Web')).toBeNull();
    expect(resolveOwningTeamId(index, 'Data', 'Data\\Models')).toBe(
      'team-data',
    );
  });

  it('is null for an unknown, empty or missing area path', () => {
    expect(resolveOwningTeamId(index, 'Delivery', 'Elsewhere')).toBeNull();
    expect(resolveOwningTeamId(index, 'Delivery', '   ')).toBeNull();
    expect(resolveOwningTeamId(index, 'Delivery', null)).toBeNull();
  });

  it('breaks a tie on team id, so the answer never depends on order', () => {
    const tied = [
      {
        projectId: 'Delivery',
        teamId: 'team-b',
        areaPaths: [{ value: 'Delivery\\Shared', includeChildren: true }],
      },
      {
        projectId: 'Delivery',
        teamId: 'team-a',
        areaPaths: [{ value: 'Delivery\\Shared', includeChildren: true }],
      },
    ];
    expect(
      resolveOwningTeamId(
        buildAreaPathIndex(tied),
        'Delivery',
        'Delivery\\Shared\\Thing',
      ),
    ).toBe('team-a');
    expect(
      resolveOwningTeamId(
        buildAreaPathIndex([...tied].reverse()),
        'Delivery',
        'Delivery\\Shared\\Thing',
      ),
    ).toBe('team-a');
  });
});

describe('teamAreaPathsFrom', () => {
  it('reads the team field values response and drops blank entries', () => {
    const paths = teamAreaPathsFrom('Delivery', 'team-web', {
      field: { referenceName: 'System.AreaPath' },
      defaultValue: 'Delivery\\Web',
      values: [
        { value: 'Delivery\\Web', includeChildren: true },
        { value: '', includeChildren: false },
      ],
    });
    expect(paths.areaPaths).toHaveLength(2);
    expect(buildAreaPathIndex([paths]).entries).toHaveLength(1);
  });
});
