# 2. TypeScript backend so hub and BFF share DTOs verbatim

Date: 2026-09-17

## Status

Accepted

## Context

The tech spec leaves the backend language open: Node 22 + Fastify, or .NET.
ExpertGroup is predominantly a .NET shop and the organisation's C# standards
are the more developed of the two rule sets, so .NET was the status quo
choice.

The deciding factor is the column mapping layer. The board's correctness rests
on one contract: a `BoardCard` carries a `teamId`, an `iterationId`, a
`sourceColumn` holding a `WEF_<boardId>_Kanban.Column` value, a resolved
`canonicalColumnId` and a `rev`. The hub sends that `rev` back on a drag, and
the BFF turns it into a `test` operation in a JSON Patch document. If the hub's
idea of that shape and the BFF's idea of it drift by one field, the failure
mode is a silently misplaced card or a lost write — the two outcomes the spec
names as trust-destroying.

The hub extension is TypeScript regardless; `azure-devops-extension-sdk` and
`azure-devops-ui` are TypeScript libraries and there is no supported
alternative. So the choice is not "TypeScript or C#", it is "one language or
two".

With .NET the shared shapes would be generated from an OpenAPI document — a
build step that can be skipped, run stale, or silently succeed against an
outdated schema.

## Decision

The BFF, the sync worker and the hub are TypeScript in one pnpm workspace.
`packages/shared` holds the DTOs and their Zod schemas and is imported by both
sides. There is no code generation step between hub and BFF.

Where ExpertGroup's C# rules express a language-independent intent, we carry
the intent across: strict null checking (`strict` plus
`noUncheckedIndexedAccess`), warnings as errors in CI, async throughout with no
blocking waits, an explicit timeout on every outbound call, structured logging
with a trace id, and Zod validation at every boundary where data arrives from
outside the process.

## Consequences

One language, one toolchain, one test runner, and a type error at the hub/BFF
boundary is a compile failure rather than a runtime surprise.

The cost is real: this service will not share libraries, conventions or on-call
familiarity with ExpertGroup's .NET services, and a .NET-only team inherits a
Node service. That cost is accepted because the boundary this protects is the
one the spec says must never drift.

A later move to .NET is a rewrite of the BFF, not a refactor. Nothing in the
architecture — the aggregation model, the cache classes, the write path, the
service-identity read / user-identity write split — depends on the language,
so the design in the spec survives such a move unchanged.
