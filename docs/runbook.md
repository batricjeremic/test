# Runbook — Cross-Project Sprint Board

Operating the Board API (BFF) and the hub extension.

The service aggregates Azure DevOps work items across projects and writes card
moves back. It holds no work item content of its own: Postgres stores board
configuration and the audit log, Redis stores card snapshots for 60 seconds.
**Losing either store loses configuration or cache, never work.**

---

## 1. Deployment

One container running `node apps/api/dist/server.js`, one Redis, one Postgres.
Image builds from `infra/Dockerfile`. West Europe, Expert Group subscription.

The hub extension is packaged separately as a `.vsix` from `apps/hub` and
published to the organisation — it is not served by this container.

### Migrations

Migrations are applied **by the pipeline, never at startup and never from a dev
session**. `app.ts` does not call them; there is no automatic path.

```bash
pnpm db:migrate
```

The runner takes a Postgres advisory lock, so two concurrent pipeline runs
cannot race. It runs each migration in a transaction, records it in
`schema_migrations` with a checksum, and **refuses to run if an already-applied
migration's file has changed**. If you see that refusal, someone edited an
applied migration: restore the file and write a new migration instead. Do not
clear the checksum.

Deploy order: migrate, then roll the container.

### Configuration

All 23 variables are documented in `apps/api/env.example`. Configuration is
validated once at startup; a bad value aborts the process with a single error
listing **every** problem at once, so one restart tells you everything that is
wrong. Secret values are never printed — the error says `value not shown`.

`ADO_SERVICE_TOKEN`, `DATABASE_URL` and `REDIS_URL` are secrets and are on the
logger's redaction list. They cannot reach a log line through any call site.

---

## 2. Health and readiness

| Endpoint          | Meaning                                            |
| ----------------- | -------------------------------------------------- |
| `GET /api/health` | The process is alive. Use for liveness probes.     |
| `GET /api/ready`  | Dependencies reported honestly. Use for readiness. |

`/api/ready` distinguishes **degraded but serving** from **down**. Do not wire a
readiness probe to fail on degraded: the board still works without Redis, just
slower, and cycling the container will not bring Redis back.

---

## 3. Degraded modes

The service is built so every degradation is visible rather than silent. These
are the four, what a user sees, and what to do.

### Redis unavailable

Every cache read reports a miss, every write is a no-op, the store reports
unhealthy, and a circuit breaker stops a dead Redis from adding its timeout to
every request. It logs **once per transition**, not once per operation.

- **User sees:** a slower board. Cold-load times, so seconds rather than
  sub-second.
- **Cost:** every board load fans out to Azure DevOps under the service
  identity. With enough users this will hit the rate limit — see §4.
- **Do:** restore Redis. No restart of the API is needed; the breaker closes on
  its own.

### Service hooks not configured or not delivering

If the webhook credentials are unset, **the webhook route is not mounted at
all** — there is no unauthenticated endpoint sitting open.

- **User sees:** a "live updates off" indicator, and a board that refreshes by
  polling every 30 seconds.
- **Do:** configure `WEBHOOK_*` (see `env.example`) and create one
  `workitem.updated` subscription per project. Setting only half a credential
  pair is a startup error, not a silent downgrade.

### A board has a project without a subscription

Same visible outcome as above, scoped to that board.

- **Do:** add the subscription. Until then the board is correct but up to 30
  seconds stale.

### Azure DevOps throttling

The client reads `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Retry-After`
on **every** response, not just failures. The sync worker runs behind a token
bucket and backs off first, so the interactive path degrades last.

- **User sees:** on a write, "Azure DevOps is busy" with a retry hint. Writes
  retry twice with backoff and then roll the card back — never silently.
- **Do:** lower `SYNC_CONCURRENCY` and `SYNC_RATE_BUDGET_PER_MINUTE`. Remember
  the budget is shared: reads from every user run under one identity.

---

## 4. When something is wrong

### "I moved a card and it snapped back"

This is answerable, by design. Every write attempt is in `audit_entry`,
successes and failures alike.

```sql
SELECT occurred_at, actor, from_column_id, to_column_id,
       outcome, failure_reason, new_rev, state_changed, trace_id
FROM audit_entry
WHERE work_item_id = $1
ORDER BY occurred_at DESC
LIMIT 20;
```

`failure_reason` names which row of the spec's failure table it hit:
`revision-conflict`, `rule-violation`, `transition-not-allowed`,
`permission-denied`, `mapping-missing` or `service-unavailable`. A database
constraint enforces the shape — a success must carry `new_rev` and
`state_changed` and no reason, a failure must carry a reason and neither — so
the log cannot record a half-truth.

`result` holds the full `MoveResult` JSONB exactly as the hub received it, so
you can see the message the user actually got. `trace_id` joins the row to the
log lines for that request.

Each failure already produced a _specific_ message in the UI. If the user
reports a **generic** failure, that is a bug worth a ticket.

Note `audit_entry.board_id` deliberately carries no foreign key: the audit log
outlives the board definition, so deleting a board does not erase who moved
what.

### "Cards are in the wrong column" / "cards are in an Unmapped lane"

Not a bug. A card whose team column has no mapping row is placed in a visible
Unmapped lane naming the team and column, deliberately, because silent
misplacement destroys trust faster than any defect.

```
GET /api/boards/:boardId/unmapped
```

Or open the admin screen — the unmapped count is its headline. The fix is a
mapping row, and the job is done when the count is zero.

### "My board and the native taskboard disagree"

Snapshot TTL is 60 seconds and a service hook invalidates sooner. Wait a minute
and re-check before investigating. If it persists past a refresh, that is drift
and a real defect — the spec's target is zero.

### "Someone can see a card they should not"

Treat as a security incident, not a display bug. Reads run under a service
identity, so trimming is ours (ADR 0003). Note that a permission **revoked** in
Azure DevOps stays effective here for up to `CACHE_TTL_ACL_SECONDS` (default 900
— 15 minutes, from the spec). If less than 15 minutes have passed since the
revocation, this is the known window, not a leak. Beyond that, it is a leak.

### The board is slow

Check in this order: is Redis healthy (`/api/ready`); is the sync worker warming
the cache (it should be, on a schedule); is the rate budget exhausted (§3); how
many teams does the board definition cover — call count grows with **teams**,
not cards, so an over-broad board definition is a common cause.

---

## 5. Logs

Structured JSON via pino. Every line carries a trace id; the hub sends a
correlation header, so a user action can be followed end to end.

Tokens, authorization headers and personal data are redacted by construction.
Logs identify people by **identity descriptor**, not display name or email —
if you need a human name, resolve it in Azure DevOps, deliberately.

---

## 6. ISO 27001 touchpoints

Flagged for whoever owns the ISMS scope, **before deployment rather than after**:

- **Asset inventory.** The service, its Postgres and its Redis are new assets.
- **Personal data.** It processes names and work assignment. Redis holds at most
  60 seconds of titles and assignees; Postgres holds none of it, but
  `audit_entry` and `person_override` hold identity descriptors and, for
  overrides, display names.
- **Access review.** The board admin role can change which projects a board
  exposes and how columns map. It needs a named owner and a periodic review.
- **Audit log retention.** `audit_entry` is append-only and grows without bound.
  It needs a retention rule — decided by the ISMS owner, then implemented as a
  scheduled deletion. **This is not yet implemented.**
- **Data residency.** All components run in West Europe in the Expert Group
  subscription; no data leaves the tenant.
- **Credential rotation.** `ADO_SERVICE_TOKEN` grants read across every project a
  board covers. It needs an owner and a rotation schedule.

---

## 7. Known limitations

- **Realtime does not survive scale-out.** WebSocket subscriptions live in
  process memory. Two API instances do not share them, so a move written through
  one is not pushed to a board held open on the other. Today the service is one
  container. Before adding a second, implement the Redis pub/sub fan-out behind
  the `RealtimePublisher` port — see ADR 0005.
- **Audit log has no retention rule yet.** See §6.
- **Extension artwork is placeholder.** `apps/hub/static/images/` holds generated
  images, not designed ones, with a README giving the required sizes.
