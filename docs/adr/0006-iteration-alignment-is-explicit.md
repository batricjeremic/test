# 6. Make mismatched sprint cadences explicit rather than reconcile them

Date: 2026-09-17

## Status

Accepted

## Context

Iteration paths are defined at project level and subscribed to per team. Two
teams can therefore be in differently dated sprints at the same moment — Dev on
day 2 of a 15-day sprint while Data and AI is on day 8 of a 10-day one.

For a board that spans projects, "this sprint" is then not one thing. Any code
that silently picks one meaning will be wrong for somebody, and the failure is
quiet: the board looks complete while omitting or misdating a team's work.

Three reconciliations were available. Pick the widest date range that covers
every team's current sprint — inflates capacity and pulls in work nobody
committed to this period. Pick the majority cadence — silently drops teams.
Require aligned cadences — correct, but it makes a configuration problem into a
blocker for a tool meant to reveal that problem.

## Decision

The board does not reconcile cadences. It makes the choice explicit and shows
its working.

Three modes:

| Mode                                 | Shows                                                   | Right when                                              |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| Each team's current sprint (default) | every team's own `@CurrentIteration`, merged            | cadences differ and you want "what is each team on now" |
| Date window                          | every card whose team iteration overlaps a chosen range | reporting a fixed period                                |
| Named iteration                      | one iteration path across teams that share it           | cadences already aligned — the cleanest board           |

In the default mode every swimlane and team badge carries that team's own sprint
dates, so a reader sees that the two teams are at different points. Capacity is
computed per team over that team's own dates, using that team's own working-days
setting, then summed per person.

**Burndown is deliberately absent in the mixed mode**, and the snapshot carries
an explicit flag saying so. A burndown over mismatched windows is a lie, and a
missing chart is better than a confident wrong one.

## Consequences

The default board is honest but busier: a reader has to take in that teams are
at different sprint days. That cost is paid in the UI, not hidden in the data.

Capacity arithmetic is per team and then summed, which is more code and more
tests than one global date range — including four-day working weeks, per-team
days off and people whose teams have different iteration lengths. Those cases
have tests because they are the cases a single-range shortcut would get wrong.

The real fix is organisational, not technical, and belongs to the rollout rather
than the code: aligning cadence across the divisions makes the named-iteration
mode viable and the board materially simpler to read. Because iteration paths
are project-level definitions with per-team subscriptions, that alignment is a
configuration change and a team agreement — not a migration. The board is built
so it does not need to wait for that, and so it keeps working if it never
happens.
