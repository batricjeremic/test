/**
 * The directory the admin screen picks sources from.
 *
 * The first real board was configured by pasting GUIDs: Azure DevOps does
 * not show a team id anywhere on screen, so an admin had to dig them out
 * of URLs, and a mistyped one fails later and quietly rather than at the
 * point of typing. These three routes exist so nobody ever types one.
 *
 * They are the only reads in the service that run under the CALLER's own
 * identity rather than the service identity. That is deliberate: a picker
 * must show what that person is allowed to see, and the cheapest correct
 * way to trim a project list is to let Azure DevOps answer as them. The
 * cost is that these are not shared-cached — acceptable for a screen
 * opened when a board is configured, and not on the board's hot path.
 */
import {
  adoProjectRefSchema,
  adoTeamBoardRefSchema,
  adoTeamRefSchema,
  nonEmptyStringSchema,
} from '@eg/shared';
import type { AdoProjectRef, AdoTeamBoardRef, AdoTeamRef } from '@eg/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userCallOptions } from '../auth/identity.js';
import { requireAuth } from '../auth/plugin.js';
import type { AdoClient, Logger } from '../ports.js';
import { parseWith } from './context.js';

export const DIRECTORY_PATH = '/api/ado';

export interface DirectoryRouteOptions {
  readonly ado: AdoClient;
  readonly logger: Logger;
  /** Explicit, like every other outbound call in the service. */
  readonly requestTimeoutMs: number;
}

const projectParamsSchema = z.object({ projectId: nonEmptyStringSchema });
const teamParamsSchema = projectParamsSchema.extend({
  teamId: nonEmptyStringSchema,
});

/** Sorted by name: a picker ordered by GUID is no better than typing one. */
const byName = <T extends { name: string }>(entries: T[]): T[] =>
  [...entries].sort((left, right) => left.name.localeCompare(right.name));

export async function directoryRoutes(
  app: FastifyInstance,
  options: DirectoryRouteOptions,
): Promise<void> {
  app.get(`${DIRECTORY_PATH}/projects`, async (request, reply) => {
    const auth = requireAuth(request);
    const call = userCallOptions(auth.identity, {
      ...auth.callOptions(),
      timeoutMs: options.requestTimeoutMs,
    });
    const projects = await options.ado.listProjects(call);
    const refs: AdoProjectRef[] = projects.map((project) =>
      adoProjectRefSchema.parse({ id: project.id, name: project.name }),
    );
    return reply.send(byName(refs));
  });

  app.get(
    `${DIRECTORY_PATH}/projects/:projectId/teams`,
    async (request, reply) => {
      const auth = requireAuth(request);
      const params = parseWith(projectParamsSchema, request.params, 'project');
      const call = userCallOptions(auth.identity, {
        ...auth.callOptions(),
        timeoutMs: options.requestTimeoutMs,
      });
      const teams = await options.ado.listTeams(params.projectId, call);
      const refs: AdoTeamRef[] = teams.map((team) =>
        adoTeamRefSchema.parse({ id: team.id, name: team.name }),
      );
      return reply.send(byName(refs));
    },
  );

  /**
   * A team's boards, which is what `BoardSource.backlogLevel` names. The
   * old editor offered two hard-coded backlog categories, neither of
   * which is what `pickBoardReference` matches on — so a wrong value fell
   * through to "the team's first board" and looked like it had worked.
   */
  app.get(
    `${DIRECTORY_PATH}/projects/:projectId/teams/:teamId/boards`,
    async (request, reply) => {
      const auth = requireAuth(request);
      const params = parseWith(teamParamsSchema, request.params, 'team');
      const call = userCallOptions(auth.identity, {
        ...auth.callOptions(),
        timeoutMs: options.requestTimeoutMs,
      });
      const boards = await options.ado.listBoards(
        params.projectId,
        params.teamId,
        call,
      );
      const refs: AdoTeamBoardRef[] = boards.map((board) =>
        adoTeamBoardRefSchema.parse({ id: board.id, name: board.name }),
      );
      return reply.send(refs);
    },
  );
}
