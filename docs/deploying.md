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

Keep the URL. You enter it once in the admin screen after installing the
extension — it is not compiled into the bundle. See §2d.

CORS is already scoped to your organisation's Azure DevOps origin, derived from
`ADO_ORG_URL`, so no extra configuration is needed. If the browser reports a
CORS failure, `ADO_ORG_URL` is wrong.

For real use, deploy it properly — see §2b.

## 2b. Deploying the backend for real

### What the backend is

`apps/api` is **one Node 22 process**, packaged as one container. It does five
things, and the sync worker runs inside the same process on its own schedule:

1. **Aggregates** — merges the iteration work items of N teams across N projects
   into one board snapshot.
2. **Caches** — Redis, so a cold fan-out does not happen per user per load.
3. **Computes** — column mapping, capacity across teams, iteration alignment.
4. **Writes** — turns a drag into a JSON Patch under the calling user's own
   identity, confirms it, and audits every attempt.
5. **Pushes** — WebSocket fan-out, and the service hook ingress.

It exists rather than having the hub call Azure DevOps directly because a cold
load is roughly 75 calls for eight teams, Azure DevOps throttles **per
identity**, and security trimming has to happen server-side once reads run under
a service identity.

### What it needs

Three things: the container, a Postgres, a Redis. Nothing else.

### Azure Container Apps

The image is built and verified by CI on every push. To deploy:

```bash
RG=rg-sprintboard
LOC=westeurope
ACR=acrsprintboard          # must be globally unique
APP=sprint-board-api

az group create -n $RG -l $LOC

# Build the image in Azure — no local Docker daemon needed.
az acr create -g $RG -n $ACR --sku Basic --admin-enabled true
az acr build -r $ACR -t sprint-board-api:1 -f infra/Dockerfile .

# Managed Postgres and Redis.
az postgres flexible-server create -g $RG -n pg-sprintboard -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --version 17 --database-name board
az redis create -g $RG -n redis-sprintboard -l $LOC --sku Basic --vm-size c0

az containerapp env create -g $RG -n cae-sprintboard -l $LOC

az containerapp create -g $RG -n $APP --environment cae-sprintboard \
  --image $ACR.azurecr.io/sprint-board-api:1 \
  --registry-server $ACR.azurecr.io \
  --ingress external --target-port 8080 \
  --min-replicas 1 --max-replicas 1 \
  --secrets ado-token=<PAT> db-url=<postgres-url> redis-url=<redis-url> \
  --env-vars \
      ADO_ORG_URL=https://dev.azure.com/<org> \
      ADO_SERVICE_TOKEN=secretref:ado-token \
      DATABASE_URL=secretref:db-url \
      REDIS_URL=secretref:redis-url
```

Container Apps gives the app an HTTPS FQDN with a certificate and supports
WebSockets on that ingress, so the realtime channel works without extra
configuration. That FQDN is what you enter in the admin screen as the board API
endpoint, once, per organisation.

### Pin it to one replica — this is not a default, it is a requirement

`--min-replicas 1 --max-replicas 1` is deliberate, and removing it breaks the
product in a way that looks like a flaky bug rather than a misconfiguration:

- **WebSocket subscriptions live in process memory** (ADR 0005). With two
  replicas, a move written through replica A is never pushed to a board held
  open on replica B. Users report "sometimes my board does not update".
- **The sync worker would run in every replica**, multiplying the load on the
  shared service-identity rate budget that the interactive path depends on.

Before scaling out, implement the Redis pub/sub fan-out behind the
`RealtimePublisher` port and make the worker leader-elected. Until then, one
replica is the supported topology.

### Migrations are a pipeline step

The service never migrates on boot — there is no entrypoint script that could
quietly start. Run them from the pipeline, against the same database, **before**
the new revision takes traffic:

```bash
DATABASE_URL=<postgres-url> pnpm db:migrate
```

`DATABASE_URL` is the only variable a migration run needs. It validates its
own narrow slice of the environment rather than the whole application config,
so the step never has to be handed an Azure DevOps token or a Redis URL it
will not use. `LOG_LEVEL` and `DATABASE_REQUEST_TIMEOUT_MS` are honoured if
set.

The runner takes an advisory lock so two concurrent pipeline runs cannot race,
and refuses to run if an already-applied migration's checksum changed.

> These commands are a working starting point, not a verified deployment —
> they have not been run against an Expert Group subscription. Names, SKUs and
> network rules will need adjusting to house policy, and the Postgres firewall
> must allow the Container App.

## 2c. Doing it from a pipeline

`azure-pipelines.yml` does all of the above. A `Verify` stage runs on every PR
and on `development`, a `Package` stage builds the one `.vsix`, and a single
`Deploy` stage deploys from `development`, bound to an Azure DevOps Environment
so approvals and checks are configured there rather than in YAML.

**There is one environment today.** The deploy stage is a template, so adding
staging and production later is two more blocks with their own environment
name, branch and variable group — nothing else changes. Until there is
somewhere real to promote to, three stages would be ceremony over a single
deployment.

Create one variable group, `sprintboard`, backed by Key Vault, holding:

| Variable            | What                                    |
| ------------------- | --------------------------------------- |
| `azureSubscription` | service connection name                 |
| `resourceGroup`     | resource group of the container app     |
| `acrName`           | container registry                      |
| `containerAppName`  | the container app                       |
| `bffBaseUrl`        | that environment's public HTTPS API URL |
| `databaseUrl`       | **secret** — Postgres connection string |

Order inside a deployment stage is deliberate: build the image, **apply
migrations, then** roll the container, then wait for `/api/ready` to answer 200
before the stage is allowed to succeed. The hub is packaged only after the API
is live, so the extension is never newer than the API it calls.

The agent must reach Postgres for the migration step — allow Azure services on
the flexible server, or run that job on a self-hosted agent inside the network.

Publishing the `.vsix` to the Marketplace is deliberately **not** automated. It
changes what every user in the organisation runs; the pipeline publishes the
file as a build artifact and a human uploads it.

## 2d. How environments actually work

The extension is built **once** and the same `.vsix` is promoted through every
environment. It carries no environment configuration: the hub reads its BFF
endpoint from an organisation-wide extension setting at runtime, set in the
admin screen. `VITE_BFF_BASE_URL` survives only as a local-development
fallback, so a fresh installation with no endpoint set fails visibly and the
admin screen says what to do.

That fixes the artifact. It does **not** by itself give you three environments.
Today there is one, which is the right number to start with — but the
constraint below decides what adding more will cost, so it is worth knowing
before anyone plans a rollout.

### The constraint

An extension is installed **per Azure DevOps organisation**, and its settings
are stored per organisation **per extension id**. So:

> one organisation + one extension id = one endpoint.

You cannot point the same installed extension at development for one person and
production for another. Three backend environments and one organisation do not
compose through a single installation.

### The two patterns that do work

**A — Two extension ids in one organisation.** Publish a second, private
extension with the id `cross-project-sprint-board-dev` alongside the real one.
They install side by side because the ids differ, each keeps its own endpoint
setting, and the non-production hub appears as a separate entry in Boards. This
is the normal Azure DevOps pattern and works with a single organisation, which
is what Expert Group has.

Cost: two manifests to keep in step, and two things in the hub navigation.

**B — A separate organisation per environment.** Cleanest isolation, and the
only option if you need production data kept away from testing entirely. It is
also the expensive one: separate organisations mean separate projects, teams,
work items and licences — and since the board reads _real_ work items, a test
organisation has no real work in it to look at.

For a tool whose whole value is aggregating live work, B tends to make
non-production testing meaningless. **A is the recommendation.**

### What that means for the pipeline

The `Package` stage builds one `.vsix` regardless. Which extension id it
carries is a manifest choice, not a pipeline one. If you adopt pattern A, the
non-production build overrides `publisher`/`id` in `vss-extension.json` —
`tfx extension create` takes `--override` for exactly this.

A deployment stage deploys a **backend**. How many backends a human can reach
from a hub depends on how many extension ids you install, which is the decision
above — and with one environment it does not arise yet.

> This decision is not made yet. The code supports both; the pipeline assumes
> one extension id until someone chooses.

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

# No environment configuration goes into the build: the hub reads its BFF
# endpoint from an organisation-wide setting at runtime (§2d).
pnpm --filter @eg/board-hub build

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

0. **Set the board API endpoint.** On a fresh installation the panel says no
   endpoint is set and that the hub is falling back to the build default —
   paste your tunnel or Container Apps URL and save. It takes effect the next
   time the hub is opened. Nothing else on the screen will work until this is
   right.
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
