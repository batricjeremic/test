# Cross-Project Sprint Board

One sprint board across every Azure DevOps project, grouped by person, with
native board interaction. An Azure DevOps hub extension plus a backing service.

It is a working surface, not a report. Queries and Delivery Plans already answer
the reporting question; people manage work by moving cards, not by reading a
list.

## Why it has to be built rather than configured

Every board object in Azure DevOps is scoped to a team, and every team to
exactly one project. There is no parent object above a project that owns boards,
so there is nothing for a cross-project board to be a setting _of_. Three
consequences shape the whole design:

1. **We aggregate, we do not extend.** The extension renders its own board from
   data pulled across projects. The native board component is not an extension
   point. (ADR 0004)
2. **Every write is team-scoped.** A dragged card must be resolved back to its
   owning team, board and iteration before it can be written, and that
   resolution has to be right the first time — a wrong team id fails outright.
3. **Columns are not a shared vocabulary.** Two teams may both have a column
   called "In Review" meaning different things. Mapping is explicit and owned by
   a human; anything unmapped is shown as unmapped, never guessed.

## Layout

```
packages/shared     DTOs and Zod schemas shared verbatim by hub and BFF
apps/api            Board API (BFF): Fastify, aggregation, write path, sync worker
apps/hub            Azure DevOps hub extension: React 18 + Vite
infra               Local Postgres/Redis compose file, production Dockerfile
docs/adr            Architecture decision records
```

`apps/api/src/ports.ts` is the seam the service is built on: `AdoClient`,
`ConfigStore`, `CacheStore`, `RealtimePublisher`, `AclResolver`, `Clock` and
`Logger` are interfaces, `container.ts` is the only file that knows which
implementation backs which port, and every test injects fakes. No test needs a
live Redis, Postgres or Azure DevOps.

## Local development

Requires Node 22 and pnpm 10.

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d    # Postgres + Redis

cp apps/api/env.example apps/api/.env               # then fill ADO_SERVICE_TOKEN
pnpm db:migrate                                     # explicit, never automatic

pnpm dev:api                                        # BFF on :8080
pnpm dev:hub                                        # hub dev server
```

`apps/api/env.example` documents all 23 variables. Configuration is validated at
startup and reports every problem at once, with secret values withheld from the
error.

### Commands

| Command           | Does                                   |
| ----------------- | -------------------------------------- |
| `pnpm build`      | Build all packages in dependency order |
| `pnpm typecheck`  | Typecheck every package                |
| `pnpm test`       | Run every test suite                   |
| `pnpm lint`       | ESLint across the workspace            |
| `pnpm format`     | Prettier, printWidth 80                |
| `pnpm db:migrate` | Apply pending migrations (CLI only)    |

## API surface

| Method                 | Path                            | Purpose                                                             |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `GET`                  | `/api/health`                   | Liveness                                                            |
| `GET`                  | `/api/ready`                    | Readiness; degraded-but-serving is distinguishable from down        |
| `GET`                  | `/api/boards/:boardId/sprint`   | The aggregated board, trimmed to the caller's ACL                   |
| `POST`                 | `/api/moves`                    | Move a card. Confirmed by Azure DevOps or rolled back               |
| `WS`                   | `/api/boards/:boardId/stream`   | Card deltas to open boards                                          |
| `POST`                 | `/api/hooks/workitem-updated`   | Service hook ingress (only mounted when credentials are configured) |
| `GET`/`POST`           | `/api/boards`                   | List and create board definitions                                   |
| `GET`/`PATCH`/`DELETE` | `/api/boards/:boardId`          | Board definition                                                    |
| `GET`/`PUT`            | `/api/boards/:boardId/sources`  | Projects and teams the board merges                                 |
| `GET`/`PUT`            | `/api/boards/:boardId/columns`  | Canonical columns                                                   |
| `GET`/`PUT`/`DELETE`   | `/api/boards/:boardId/mappings` | Per-team column mapping                                             |
| `GET`                  | `/api/boards/:boardId/unmapped` | Unmapped column count and list                                      |

## Two rules that are not negotiable

From the spec, and enforced by tests rather than by convention:

- **A move is never reported as saved until Azure DevOps confirms it.** No
  fire-and-forget, no queue that swallows failures. Every patch document opens
  with a `test` operation on `/rev` carrying the revision the user's card held,
  so a concurrent edit is rejected rather than overwritten. Where a mapping
  supplies a `targetState`, the board column and `System.State` are written in
  one document, so they cannot diverge.
- **Every write attempt is audited, success or failure.** The first support
  question will be "I moved that card and it went back". A failed audit write
  never turns a successful move into a reported failure.

## Security posture

Reads run under a service identity, so **security trimming is our
responsibility, not the platform's** — see ADR 0003. The resolver fails closed,
an untrimmed snapshot is a distinct type that cannot become a response without
passing through the trim function, and a lane emptied by permissions still
renders with a count so a person knows something exists without seeing what.

Writes run as the calling user, so the Azure DevOps history stays honest.

The extension requests `vso.work_write` and `vso.project` only — nothing for
code, builds or releases. Postgres holds configuration and the audit log, never
work item content; Redis holds card snapshots for 60 seconds.

## Documentation

- `docs/deploying.md` — **start here for a first run**: packaging the extension,
  installing it in an organisation, and configuring the first board
- `docs/adr/` — why the constrained decisions were made the way they were
- `docs/runbook.md` — operating the service: configuration, migrations,
  degraded modes, what to check when it misbehaves
