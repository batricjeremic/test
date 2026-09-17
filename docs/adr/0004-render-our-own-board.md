# 4. Render our own board rather than reuse the native one

Date: 2026-09-17

## Status

Accepted

## Context

Every board object in Azure DevOps is scoped to a team, and every team to
exactly one project. There is no parent object above a project that owns
boards, so a cross-project board cannot be a setting or a configuration of the
native board — there is nothing for it to be a setting _of_.

Nor can the native board component be embedded and fed merged data. It is not
a supported extension point; there is no public API that hands an extension the
board renderer with its own data source.

A related question is the component library. The spec names `azure-devops-ui`,
Microsoft's component set for extensions. It peer-pins React 16.8, while the hub
is React 18. Installing it against React 18 means either forcing a resolution
that the library was never tested under, or pinning the whole hub to React 16
and giving up concurrent rendering on a board that must stay responsive while
400 cards re-render under a drag.

## Decision

The extension aggregates; it does not extend. It pulls data across projects
through the BFF and renders its own board: its own columns, swimlanes, cards
and drag-and-drop, with `@dnd-kit` for the interaction and our own components
styled from the Azure DevOps theme variables the SDK exposes.

`azure-devops-ui` is not a dependency. The hub stays on React 18.

Card detail is the exception: opening a card opens the _native_ work item form
in a dialog, because that form carries process rules, custom fields and
permissions we must not reimplement.

## Consequences

The board can show something Azure DevOps cannot, which is the entire point of
the product. Nothing in the layout is constrained by a component designed for a
single team's board.

The costs are real and permanent:

- **We own the visual drift.** When Azure DevOps restyles its boards, ours does
  not follow. Theming through the SDK's CSS variables keeps light and dark
  correct, but it will not keep us pixel-identical, and we should not pretend
  otherwise to users.
- **We own accessibility.** A native board's keyboard and screen-reader
  behaviour came for free; ours does not. Keyboard dragging through `@dnd-kit`'s
  keyboard sensor and live-region announcements are therefore requirements with
  tests, not enhancements.
- **We own the parity question.** The spec's success criteria include "zero
  drift between our board and the native taskboard after cache refresh". Since
  the two renderers are independent, parity is something we verify, not
  something we inherit.

If Microsoft ever ships a supported cross-project board or an embeddable board
component, this decision is worth revisiting — it is the largest single piece of
surface we maintain.
