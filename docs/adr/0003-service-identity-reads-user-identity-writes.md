# 3. Reads under a service identity, writes under the user's

Date: 2026-09-17

## Status

Accepted

## Context

The board merges work items from every project a board definition covers. On a
cold load that is roughly 75 Azure DevOps calls for eight teams across three
projects, because almost every endpoint we need is team-scoped: call count
grows with the number of teams, not the number of cards.

Azure DevOps throttles per identity over a sliding window. If each user's board
load ran under that user's own token, every user would pay their own cold fan-out
and no two users could share a cached result. The spec's targets — first paint
under 2s warm, under 8s cold — are not reachable that way.

The obvious fix, running everything under one service identity, breaks something
else. A card moved through a service account appears in the Azure DevOps work
item history as changed by that account. Notifications go to the wrong place.
The audit trail inside Azure Boards, which people already trust and already use,
becomes worthless — and we would have replaced it with our own log, which is a
second source of truth the spec explicitly rules out.

## Decision

The two paths use two identities.

**Reads** run under one service identity. Many users share one warm cache and
one rate-limit budget. Because the platform is no longer enforcing per-user
visibility, **security trimming becomes our responsibility**: the BFF resolves
the caller's readable projects and area paths, caches that ACL for 15 minutes
keyed by identity, and removes everything outside it from the snapshot before it
leaves the server.

**Writes** carry the calling user's own token. The hub obtains it from
`SDK.getAccessToken()`; the BFF exchanges it and calls Azure DevOps as that
person. History, notifications and permissions all behave as if they had moved
the card on the native board, because in every way that matters they did.

The `AdoClient` port takes an explicit auth identity per call, so a call site
cannot silently inherit the wrong one. The two are separate accessors on the
container, not a default with an override.

## Consequences

The board is fast, and the Azure DevOps audit trail stays honest. Those were the
two things worth protecting.

We now own an authorisation decision the platform used to make for us, and
getting it wrong leaks a card to someone who cannot see it in Azure DevOps.
That is the single most dangerous defect this service can have, so it is
constrained by construction rather than by care: an untrimmed snapshot is a
distinct type that must pass through the trim function before it can become a
response, and the resolver fails closed — an ACL that cannot be resolved serves
nothing, never everything. The trimming invariant carries its own test suite.

The service identity's rate budget is a shared resource. The sync worker
therefore runs at low concurrency behind a token bucket and backs off before the
interactive path is affected; a careless raise of `SYNC_CONCURRENCY` degrades
every user's board at once.

The ACL cache means a permission revoked in Azure DevOps can remain effective
here for up to 15 minutes. That window is deliberate and comes from the spec.
It is the one place where our answer to "can this person see this card" is
knowingly stale, and it belongs in the access review.
