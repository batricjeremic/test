# 7. Validate the hub's token by asking Azure DevOps, not by parsing it

Date: 2026-09-17

## Status

Accepted

## Context

The spec says the hub sends the token from `SDK.getAccessToken()` on every
request, and that "the BFF validates it against the Azure DevOps issuer and
extracts the caller's identity descriptor".

We read that the conventional way: verify the token locally as a JWT — check
the signature against the issuer's JWKS, check issuer, audience and expiry,
read the descriptor from a claim. That is what `auth/token.ts` does, it is
thoroughly tested, and it is wrong for this token.

The first request from a real browser to the deployed service was refused:

```
{"code":"unauthorized","status":401,"reason":"malformed","route":"/api/boards"}
```

`malformed` is the rejection that fires before issuer or audience is examined:
the token does not parse as a JWT at all. What the extension SDK hands the hub
is a token minted for the extension, meaningful to Azure DevOps and opaque to
us. No amount of issuer or audience configuration was going to fix it, because
there was nothing to configure — the shape was wrong.

Nothing in our test suite could have caught this. Every test on both sides used
a token we had minted ourselves, so both sides agreed on a fiction.

## Decision

The BFF validates the token by **spending it**: one call to
`GET {orgUrl}/_apis/connectionData` carrying it as a bearer.

- A `200` with an `authenticatedUser` is proof the token is valid _and_ carries
  the identity descriptor we need, in one round trip.
- A `401` or `403` is a refusal by the issuer, and the caller is refused.
- Anything else is an outage, kept distinct from a refusal: telling a signed-in
  person to sign in again because Azure DevOps is down is a different and worse
  failure than telling them their session expired.

Azure DevOps is still the issuer doing the deciding. We ask it rather than
re-derive its answer.

`TokenVerifier` was already an interface with the implementation injected by
`container.ts`, so this is a second implementation rather than a rewrite. The
JWT verifier stays in the tree for a deployment whose hub is handed a genuine
JWT.

## Consequences

**Authentication now depends on Azure DevOps being reachable.** Local JWT
verification would have kept working through an outage; introspection does not.
A result is cached for five minutes keyed by a SHA-256 of the token — never the
token — which bounds both the latency and the blast radius. The cache is
bounded in size so a flood of distinct tokens cannot grow it without limit.

**One extra outbound call on a cold token**, inside the same timeout discipline
as every other call in the service.

**We learn less about the token.** Introspection reports neither its expiry nor
its scopes. `expiresAt` therefore means "how long we are willing to vouch
without asking again", not the token's own lifetime, and `scopes` is empty
rather than invented — the manifest declares the scopes and Azure DevOps
enforces them on the calls we make.

**A 200 is not enough on its own.** Azure DevOps answers `connectionData` for
an anonymous caller too, with no descriptor. Accepting that would sign in
nobody as somebody, so a response without a descriptor is refused explicitly
and there is a test that keeps it that way.

The wider lesson is recorded here because it will recur: every layer of this
service was tested against a fixture of what we believed the outside world
returns. The board's Zod schemas for Azure DevOps responses carry exactly the
same risk, and the first live board is where that gets found out.

## Postscript: it recurred immediately

The first deployment of this decision failed for the reason predicted two
paragraphs above. `connectionData` is a preview resource, so
`api-version=7.1` is refused with a `400` telling you to supply `-preview`.
Every request came back `introspection-unavailable`, which reads as "Azure
DevOps is down" and was in fact "our URL is wrong".

There was a test pinning that URL. It pinned the wrong version, because it
was written from the same belief as the code. A test cannot referee a
disagreement between us and the outside world when only one side is in the
room.

Two changes came out of it. A non-401/403 `4xx` from introspection is now
logged as _our request being wrong_ rather than blending into the outage
case — the two are indistinguishable to a caller but not to whoever is
reading the log. And the fixture in `introspect.test.ts` is now a copy of a
real response rather than an invention, with a comment saying so, which is
the only part of the arrangement that was ever going to catch this.
