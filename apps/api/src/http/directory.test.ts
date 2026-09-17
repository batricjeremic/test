import { describe, expect, it } from 'vitest';
import {
  adoProjectRefSchema,
  adoTeamBoardRefSchema,
  adoTeamRefSchema,
} from '@eg/shared';
import { z } from 'zod';
import {
  bearer,
  buildTestApp,
  seedDeliveryBoard,
  type TestHarness,
} from './test-support.js';

const withApp = async (
  body: (harness: TestHarness) => Promise<void>,
): Promise<void> => {
  const harness = await buildTestApp();
  seedDeliveryBoard(harness);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
};

describe('the directory behind the source picker', () => {
  it('answers projects in the shape the picker parses, sorted by name', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/ado/projects',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(200);
      const projects = z.array(adoProjectRefSchema).parse(response.json());
      expect(projects.length).toBeGreaterThan(0);
      expect(projects.map((project) => project.name)).toEqual(
        [...projects.map((project) => project.name)].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
    });
  });

  it('answers a project’s teams', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/ado/projects/Delivery/teams',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(200);
      const teams = z.array(adoTeamRefSchema).parse(response.json());
      expect(teams.map((team) => team.id)).toContain('team-dev');
    });
  });

  // The value that goes into BoardSource.backlogLevel. The old editor
  // offered two hard-coded backlog categories, neither of which is what
  // pickBoardReference matches on, so a wrong one silently fell through
  // to the team's first board.
  it('answers a team’s boards, which is what backlogLevel names', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({
        url: '/api/ado/projects/Delivery/teams/team-dev/boards',
        headers: bearer('reader-token'),
      });

      expect(response.statusCode).toBe(200);
      const boards = z.array(adoTeamBoardRefSchema).parse(response.json());
      expect(boards.length).toBeGreaterThan(0);
    });
  });

  it('refuses an unauthenticated caller', async () => {
    await withApp(async (harness) => {
      const response = await harness.app.inject({ url: '/api/ado/projects' });
      expect(response.statusCode).toBe(401);
    });
  });
});
