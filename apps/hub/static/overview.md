# Cross-Project Sprint Board

One sprint board across every Azure DevOps project, grouped by person, with
native board interaction.

Azure DevOps scopes every board to a team and every team to a project. There is
no object above a project that owns boards, so a view spanning projects cannot
be configured — it has to be built. This extension builds it.

## What it does

- **One hub, every project.** See the current sprint across the projects and
  teams you choose, without opening each team's taskboard in turn.
- **Grouped by person, once.** A person on three teams appears in one swimlane
  with one capacity bar, not three rows. Seeing someone twice is the problem
  this replaces.
- **Real board interaction.** Drag a card between columns and the change lands
  in Azure DevOps, on the owning team's board. A move is never shown as saved
  until Azure DevOps confirms it.
- **Capacity across teams.** Capacity, committed work and load summed over all
  of a person's teams, computed per team over that team's own sprint dates —
  so a four-day week and a mismatched cadence both come out right.
- **Columns reconciled by a human.** Two teams may both have a column called
  "In Review" that means different things. An admin maps each team's columns
  onto a shared set once. Anything unmapped goes to a visible Unmapped lane
  naming the team and column — never guessed into place.

## What it does not do

Backlog ordering and grooming, creating work items, editing capacity and
burndown over mismatched sprints all stay where they belong, in Azure Boards.
This is a working surface, not a second source of truth: no work item data is
stored outside Azure DevOps beyond a short-lived cache.

## Permissions

The extension requests `vso.work_write` and `vso.project` only — enough for
boards, taskboards, capacity and work item writes, and deliberately nothing
for code, builds or releases.

Reads are served from a warm shared cache and trimmed to what you personally
can see in Azure DevOps. Writes are made **as you**, with your own identity, so
the history and notifications in Azure Boards attribute the change correctly.

## Setup

An administrator creates a board definition, picks the projects and teams it
covers, declares the shared columns and maps each team's columns onto them.
The admin screen shows the count of unmapped columns; the job is done when that
count is zero.
