# Deploying and first run

How to get the board in front of a real person for the first time, in order,
with the clicks named.

## The constraint that shapes everything

The hub runs **inside an Azure DevOps iframe, in the user's browser**. Two
consequences you cannot design around:

1. **The hub cannot run standalone.** Opening the Vite dev server directly
   renders "Azure DevOps did not finish loading this hub" — `SDK.init()` never
   completes outside the Azure DevOps frame. That is correct behaviour, not a
   bug. The extension must be installed in an organisation to be exercised.
2. **The BFF must be reachable from the user's browser over HTTPS.**
   `http://localhost:8080` is not reachable from `dev.azure.com`. For the first
   run use a dev tunnel; for real use, deploy it.

So the order is: backend up → backend reachable → extension packaged →
extension installed → board configured.

---

## 1. Backend up

```bash
docker compose -f infra/docker-compose.yml up -d   # Postgres + Redis
cp apps/api/env.example apps/api/.env
```

Fill four values in `apps/api/.env`:

| Variable            | Value                               |
| ------------------- | ----------------------------------- |
| `ADO_ORG_URL`       | `https://dev.azure.com/<your-org>`  |
| `ADO_SERVICE_TOKEN` | a PAT — see below                   |
| `DATABASE_URL`      | leave the compose default for local |
| `REDIS_URL`         | leave the compose default for local |

### Creating the service PAT — where to click

`ADO_SERVICE_TOKEN` is a **Personal Access Token**, sent as HTTP Basic (the
client base64-encodes `:<token>`), not a bearer token.

1. Azure DevOps → avatar, top right → **User settings** → **Personal access
   tokens**
2. **+ New Token**
3. Organization: your organisation. Expiration: short, for a first test.
4. Scopes → **Custom defined**:
   - **Work Items** → _Read_
   - **Project and Team** → _Read_
     Nothing else. This identity only ever reads; writes go out under the calling
     user's own token.
5. **Create**, then copy it — Azure DevOps shows it once.

Then:

```bash
pnpm db:migrate      # explicit. The service never migrates on boot.
pnpm dev:api         # http://localhost:8080
curl localhost:8080/api/health
```

If configuration is wrong the process aborts and lists **every** problem at
once, with secret values withheld. Fix them all, restart once.

## 2. Make the backend reachable

For a first test, a tunnel is far faster than a deployment:

```bash
# Any of these; the result is a public HTTPS URL for port 8080.
devtunnel host -p 8080 --allow-anonymous
# or: ngrok http 8080
# or: VS Code → Ports → Forward 8080 → set visibility Public
```

Keep the URL — the hub bundle needs it at **build time**.

CORS is already scoped to your organisation's Azure DevOps origin, derived from
`ADO_ORG_URL`, so no extra configuration is needed. If the browser reports a
CORS failure, `ADO_ORG_URL` is wrong.

For real use, deploy `infra/Dockerfile` to Azure Container Apps with Redis and
Postgres alongside, and run `pnpm db:migrate` as a pipeline step before the
container rolls.

## 3. Package the extension

### A publisher, once

The manifest declares `"publisher": "expertgroup"`. A publisher id is global and
must be one you own.

1. Go to **https://marketplace.visualstudio.com/manage**
2. Sign in with the same account, **Create publisher**
3. If `expertgroup` is taken, pick another id and change `publisher` in
   `apps/hub/vss-extension.json` to match. They must be identical or the upload
   is rejected.

### Build and package

```bash
npm i -g tfx-cli

# The BFF URL is baked into the bundle at build time, not read at runtime.
VITE_BFF_BASE_URL=https://<your-tunnel-or-host> pnpm --filter @eg/board-hub build

cd apps/hub
tfx extension create --manifest-globs vss-extension.json
```

That writes `expertgroup.cross-project-sprint-board-0.1.0.vsix`.

> Bump `version` in `vss-extension.json` for every upload. The Marketplace
> refuses a version it has already seen, and this is the single most common
> way to lose ten minutes here.

## 4. Install it — where to click

1. **https://marketplace.visualstudio.com/manage** → your publisher → **New
   extension** → **Azure DevOps** → upload the `.vsix`
2. Leave it **private**. It stays invisible to everyone else.
3. On the extension row: **⋯** → **Share/Unshare** → add your organisation
4. In Azure DevOps: **Organization settings** → **Extensions** → **Shared** tab
   → your extension → **Install**
5. Open **Boards**. The hub appears in the group; the admin screen appears under
   the settings contribution.

The first load asks for consent to `vso.work_write` and `vso.project`. Nothing
else is requested.

## 5. Configure the first board

Do this in the admin screen, not with curl — it is the screen whose whole job is
making misconfiguration visible.

1. Create a board definition: a name and a default grouping.
2. Add **one source**: one project, one team. **Not eight.** The first run is
   about finding out what real Azure DevOps data does to the code; one team
   makes every failure legible.
3. Declare canonical columns — start by copying that one team's own columns.
4. Map that team's columns onto them.
5. Watch the **unmapped count**. The screen exists so that number reaches zero.

Then open the board.

## 6. What "it works" looks like

- The board renders the team's current sprint, grouped by person.
- Each person has one capacity bar. A person with no capacity record shows a
  partial-capacity marker rather than looking under-loaded.
- Dragging a card between mapped columns moves it, and the change is visible on
  the native taskboard within the 60-second snapshot TTL.
- Dragging onto an unmapped column is refused at drag start, before any request.
- "Live updates off" is shown until service hooks are configured. That is
  expected — see §3 of the runbook.

## 7. What to expect to go wrong

This has never run against a live organisation. Everything is tested against
fakes, so the first real run is the real integration test. The likely failures,
in order of probability:

| Symptom                              | Where to look                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| A response fails Zod parsing         | `apps/api/src/ado/types.ts` — a real field is nullable or named differently than modelled  |
| Cards land in Unmapped               | Expected until mapping is complete. The admin screen names the team and column             |
| A move is refused by a process rule  | `System.State` transition not allowed for that process; the toast names the allowed states |
| 401 from the hub                     | Token audience or issuer — `apps/api/src/auth/token.ts`                                    |
| Board is empty but the team has work | Area path resolution — `apps/api/src/domain/area-paths.ts`                                 |

Every failure is logged with a trace id, and every write attempt is in
`audit_entry`. Start there rather than in the browser console.
