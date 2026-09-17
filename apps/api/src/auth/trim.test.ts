/**
 * The invariant these tests exist for: a card outside the caller's ACL
 * is never in the output, whatever else is true of the snapshot.
 */
import { describe, expect, it } from 'vitest';
import { UNASSIGNED_LANE_ID, UNMAPPED_COLUMN_ID } from '@eg/shared';
import type { BoardSnapshot, PersonLoad } from '@eg/shared';
import {
  areaPathInScope,
  boardSnapshotBody,
  cardVisibility,
  trimBoardSnapshot,
  trimBoardSnapshotWithSummary,
  untrimmedSnapshot,
} from './trim.js';
import {
  TEST_DESCRIPTOR,
  makeAcl,
  makeCard,
  makePersonLoad,
  makeSnapshot,
  makeTeamView,
} from './test-support.js';

const ANA = 'aad.YW5h';
const BOJAN = 'aad.Ym9qYW4=';

const cards = [
  makeCard({ workItemId: 101, project: 'Delivery', descriptor: ANA }),
  makeCard({ workItemId: 102, project: 'Delivery', descriptor: null }),
  makeCard({ workItemId: 901, project: 'Secret', descriptor: BOJAN }),
  makeCard({
    workItemId: 902,
    project: 'Secret',
    descriptor: ANA,
    remainingWork: 12,
  }),
];

const snapshot = (): BoardSnapshot =>
  makeSnapshot({ cards, projectIds: ['Delivery', 'Secret'] });

const deliveryOnly = makeAcl({
  readableProjectIds: ['Delivery'],
  writableProjectIds: ['Delivery'],
});

describe('trimBoardSnapshot', () => {
  it('removes every card outside the ACL', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );

    expect(trimmed.cards.map((card) => card.workItemId)).toEqual([101, 102]);
    expect(trimmed.cards.every((card) => card.project === 'Delivery')).toBe(
      true,
    );
  });

  it('leaks nothing about a trimmed card, not even its title', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );
    const serialised = JSON.stringify(boardSnapshotBody(trimmed));

    expect(serialised).not.toContain('901');
    expect(serialised).not.toContain('902');
    expect(serialised).not.toContain('Work item 901');
    expect(serialised).not.toContain('Secret');
  });

  it('keeps a lane that trimming emptied, with its hidden count', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );
    const lane = trimmed.swimlanes.find(
      (candidate) => candidate.personDescriptor === BOJAN,
    );

    expect(lane).toBeDefined();
    expect(lane?.cardCount).toBe(0);
    expect(lane?.hiddenCardCount).toBe(1);
    expect(lane?.remainingWorkHours).toBe(0);
  });

  it('recounts a lane that lost some but not all of its cards', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );
    const lane = trimmed.swimlanes.find(
      (candidate) => candidate.personDescriptor === ANA,
    );

    expect(lane?.cardCount).toBe(1);
    expect(lane?.hiddenCardCount).toBe(1);
    expect(lane?.remainingWorkHours).toBe(4);
  });

  it('keeps the Unassigned lane pinned and counted', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );
    const lane = trimmed.swimlanes.find(
      (candidate) => candidate.id === UNASSIGNED_LANE_ID,
    );

    expect(lane?.order).toBe(0);
    expect(lane?.cardCount).toBe(1);
  });

  it('adds what it removed to the snapshot hidden count', () => {
    const source = makeSnapshot({
      cards,
      projectIds: ['Delivery', 'Secret'],
      hiddenCardCount: 3,
    });
    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);

    expect(trimmed.hiddenCardCount).toBe(5);
  });

  it('drops team views whose project the caller cannot read', () => {
    const result = trimBoardSnapshotWithSummary(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );

    expect(result.snapshot.teams.map((team) => team.projectId)).toEqual([
      'Delivery',
    ]);
    expect(result.summary).toEqual({
      cardsBefore: 4,
      cardsAfter: 2,
      cardsRemoved: 2,
      teamsRemoved: 1,
    });
  });

  it('restates permissions from the ACL, not from the input', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );

    expect(trimmed.permissions).toEqual({
      descriptor: TEST_DESCRIPTOR,
      readableProjectIds: ['Delivery'],
      writableProjectIds: ['Delivery'],
      canAdminister: false,
    });
  });

  it('serves nothing when the ACL is empty, rather than everything', () => {
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      makeAcl(),
    );

    expect(trimmed.cards).toEqual([]);
    expect(trimmed.teams).toEqual([]);
    expect(trimmed.personLoad).toEqual([]);
    expect(trimmed.hiddenCardCount).toBe(4);
    // The lanes stay, so the board says "there is work here" without
    // saying whose or what.
    expect(trimmed.swimlanes.length).toBeGreaterThan(0);
    expect(
      trimmed.swimlanes.reduce((sum, lane) => sum + lane.hiddenCardCount, 0),
    ).toBe(4);
  });
});

describe('write permission', () => {
  it('marks a readable but unwritable project as not writable', () => {
    const readOnly = makeAcl({
      readableProjectIds: ['Delivery', 'Secret'],
      writableProjectIds: [],
    });
    const trimmed = trimBoardSnapshot(untrimmedSnapshot(snapshot()), readOnly);

    expect(trimmed.teams).toHaveLength(2);
    expect(trimmed.teams.every((team) => !team.writable)).toBe(true);
    expect(trimmed.permissions.writableProjectIds).toEqual([]);
    // Nothing was hidden: a read-only project is dimmed, not trimmed.
    expect(trimmed.cards).toHaveLength(4);
  });

  it('marks a writable project as draggable', () => {
    const mixed = makeAcl({
      readableProjectIds: ['Delivery', 'Secret'],
      writableProjectIds: ['Delivery'],
    });
    const trimmed = trimBoardSnapshot(untrimmedSnapshot(snapshot()), mixed);
    const byProject = new Map(
      trimmed.teams.map((team) => [team.projectId, team.writable]),
    );

    expect(byProject.get('Delivery')).toBe(true);
    expect(byProject.get('Secret')).toBe(false);
  });
});

describe('area paths', () => {
  it('refines project readability when the builder knows the path', () => {
    const source = makeSnapshot({
      cards: [
        makeCard({ workItemId: 1, project: 'Delivery', descriptor: ANA }),
        makeCard({ workItemId: 2, project: 'Delivery', descriptor: ANA }),
      ],
      projectIds: ['Delivery'],
    });
    const acl = makeAcl({
      readableProjectIds: ['Delivery'],
      readableAreaPaths: ['Delivery\\Web'],
    });
    const areaPaths = new Map([
      [1, 'Delivery\\Web\\Checkout'],
      [2, 'Delivery\\Payments'],
    ]);

    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(source, areaPaths),
      acl,
    );

    expect(trimmed.cards.map((card) => card.workItemId)).toEqual([1]);
  });

  it('treats an unresolved area scope as no area restriction', () => {
    expect(areaPathInScope([], 'Delivery\\Web')).toBe(true);
    expect(areaPathInScope(['Delivery'], null)).toBe(true);
  });

  it('matches area paths whatever the slashes and casing', () => {
    expect(areaPathInScope(['delivery/web'], 'Delivery\\Web\\Checkout')).toBe(
      true,
    );
    expect(areaPathInScope(['Delivery\\Web'], 'Delivery\\Website')).toBe(false);
  });
});

describe('derived counts', () => {
  it('recomputes per-person load over the readable teams only', () => {
    const load: PersonLoad = makePersonLoad(ANA, cards, [
      'Delivery',
      'Secret',
    ]);
    const source: BoardSnapshot = {
      ...makeSnapshot({ cards, projectIds: ['Delivery', 'Secret'] }),
      personLoad: [load],
    };

    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);
    const ana = trimmed.personLoad[0];

    expect(ana).toBeDefined();
    expect(ana?.perTeam.map((entry) => entry.projectId)).toEqual(['Delivery']);
    expect(ana?.capacityHours).toBe(40);
    expect(ana?.committedHours).toBe(4);
    expect(ana?.load).toBe(0.1);
    expect(ana?.cardCount).toBe(1);
    // The footnote: a team was excluded, so the bar is not complete.
    expect(ana?.outOfScopeTeamCount).toBe(1);
    expect(ana?.partialCapacity).toBe(true);
  });

  it('drops a person whose every team and card was trimmed', () => {
    const source: BoardSnapshot = {
      ...makeSnapshot({ cards, projectIds: ['Delivery', 'Secret'] }),
      personLoad: [makePersonLoad(BOJAN, cards, ['Secret'])],
    };

    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);

    expect(trimmed.personLoad).toEqual([]);
  });

  it('counts cards without remaining work separately', () => {
    const withoutHours = [
      makeCard({
        workItemId: 11,
        project: 'Delivery',
        descriptor: ANA,
        remainingWork: null,
      }),
      makeCard({ workItemId: 12, project: 'Delivery', descriptor: ANA }),
    ];
    const source: BoardSnapshot = {
      ...makeSnapshot({ cards: withoutHours, projectIds: ['Delivery'] }),
      personLoad: [makePersonLoad(ANA, withoutHours, ['Delivery'])],
    };

    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);
    const lane = trimmed.swimlanes.find(
      (candidate) => candidate.personDescriptor === ANA,
    );

    expect(lane?.cardsWithoutRemainingWork).toBe(1);
    expect(lane?.remainingWorkHours).toBe(4);
    expect(trimmed.personLoad[0]?.cardsWithoutRemainingWork).toBe(1);
  });

  it('recounts unmapped columns and drops the ones left empty', () => {
    const unmapped = [
      makeCard({
        workItemId: 21,
        project: 'Delivery',
        descriptor: ANA,
        canonicalColumnId: UNMAPPED_COLUMN_ID,
        sourceColumn: 'In Review',
      }),
      makeCard({
        workItemId: 22,
        project: 'Secret',
        descriptor: ANA,
        canonicalColumnId: UNMAPPED_COLUMN_ID,
        sourceColumn: 'Triage',
      }),
    ];
    const source: BoardSnapshot = {
      ...makeSnapshot({ cards: unmapped, projectIds: ['Delivery', 'Secret'] }),
      unmappedColumns: [
        {
          projectId: 'Delivery',
          teamId: 'Delivery-team',
          teamName: 'Delivery-team',
          sourceColumn: 'In Review',
          cardCount: 1,
        },
        {
          projectId: 'Secret',
          teamId: 'Secret-team',
          teamName: 'Secret-team',
          sourceColumn: 'Triage',
          cardCount: 1,
        },
      ],
    };

    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);

    expect(trimmed.unmappedColumns).toEqual([
      {
        projectId: 'Delivery',
        teamId: 'Delivery-team',
        teamName: 'Delivery-team',
        sourceColumn: 'In Review',
        cardCount: 1,
      },
    ]);
  });

  it('keeps team-grouped lanes when the grouping is by team', () => {
    const source: BoardSnapshot = {
      ...makeSnapshot({ cards, projectIds: ['Delivery', 'Secret'] }),
      grouping: 'team',
      swimlanes: [
        {
          id: 'team:Delivery-team',
          kind: 'team',
          label: 'Delivery-team',
          personDescriptor: null,
          teamId: 'Delivery-team',
          order: 0,
          cardCount: 2,
          hiddenCardCount: 0,
          remainingWorkHours: 8,
          cardsWithoutRemainingWork: 0,
        },
        {
          id: 'team:Secret-team',
          kind: 'team',
          label: 'Secret-team',
          personDescriptor: null,
          teamId: 'Secret-team',
          order: 1,
          cardCount: 2,
          hiddenCardCount: 0,
          remainingWorkHours: 16,
          cardsWithoutRemainingWork: 0,
        },
      ],
      teams: [makeTeamView('Delivery'), makeTeamView('Secret')],
    };

    const trimmed = trimBoardSnapshot(untrimmedSnapshot(source), deliveryOnly);

    expect(trimmed.swimlanes).toHaveLength(2);
    expect(trimmed.swimlanes[1]?.cardCount).toBe(0);
    expect(trimmed.swimlanes[1]?.hiddenCardCount).toBe(2);
  });
});

describe('cardVisibility', () => {
  it('agrees with what the trim produced', () => {
    const isVisible = cardVisibility(deliveryOnly);
    const trimmed = trimBoardSnapshot(
      untrimmedSnapshot(snapshot()),
      deliveryOnly,
    );

    expect(cards.filter(isVisible)).toEqual(trimmed.cards);
  });
});
