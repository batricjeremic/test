# 5. Plain WebSocket instead of SignalR

Date: 2026-09-17

## Status

Accepted

## Context

The spec leaves the realtime transport open: "SignalR or plain WebSocket". The
job is narrow — when someone moves a card, every other open board showing that
card should see it move, so two people dragging cards do not fight over stale
state.

SignalR earns its keep when you need transport negotiation for clients that
cannot hold a WebSocket, a hub/RPC programming model, groups and user-targeted
sends, and a backplane for scaling out. Its natural home is .NET; the Node
story is a client library, and Azure SignalR Service is another piece of
managed infrastructure to provision, pay for and reason about.

Our client is not an arbitrary browser. It is an Azure DevOps hub, running in a
modern browser inside a product that already requires WebSocket support. There
is exactly one message direction that matters (server to client), one grouping
concept (a board channel), and the fallback is already specified and already
required for a different reason: if service hooks are unavailable the hub polls
every 30 seconds and shows "live updates off".

## Decision

A plain WebSocket endpoint via `@fastify/websocket`, in the same process as the
BFF. One channel per board. The server pushes card deltas; the client sends
nothing but a subscribe frame.

The hub reconnects with bounded exponential backoff and falls back to 30-second
polling when it cannot hold a socket, surfacing that as a visible "live updates
off" state rather than degrading silently.

## Consequences

No extra managed service, no backplane, no negotiation handshake, and the
realtime module is small enough to test exhaustively with a fake socket.

The limitation is scale-out. Because subscriptions live in process memory, two
API instances do not share them: a move written through instance A is not pushed
to a board held open on instance B. Today the service is one container, so this
costs nothing. **The moment a second instance is added, this breaks in a way
that looks like a mysterious "sometimes my board does not update".**

The fix, when that day comes, is a Redis pub/sub fan-out between instances —
Redis is already a dependency and the `RealtimePublisher` port is the seam it
plugs into, so it is a contained change rather than a rewrite. This is recorded
here so the next person finds the reason before they find the symptom.

The fallback path means a realtime outage degrades rather than breaks: the board
keeps working, one polling interval behind, and says so.
