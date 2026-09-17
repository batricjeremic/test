/**
 * Board filters: project, team, work item type, tag, state, unassigned.
 *
 * Spec: "Scope and non-goals". Filters compose — within one facet the
 * values are alternatives, across facets they all have to hold — and an
 * empty facet means no restriction.
 *
 * Ids are matched exactly. Free text an admin types by hand, meaning
 * types, tags and states, is matched case-insensitively, because
 * Azure DevOps treats those that way itself.
 */
import type { BoardCard, BoardFilterSet } from '@eg/shared';
import { isUnassignedCard } from './cards.js';

const lowerSet = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map((value) => value.trim().toLowerCase()));

/** Pre-built matcher, so a large snapshot is not re-lowercasing per card. */
export interface CompiledBoardFilters {
  readonly projectIds: ReadonlySet<string>;
  readonly teamIds: ReadonlySet<string>;
  readonly workItemTypes: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
  readonly states: ReadonlySet<string>;
  readonly unassignedOnly: boolean;
}

export function compileBoardFilters(
  filters: BoardFilterSet,
): CompiledBoardFilters {
  return {
    projectIds: new Set(filters.projectIds),
    teamIds: new Set(filters.teamIds),
    workItemTypes: lowerSet(filters.workItemTypes),
    tags: lowerSet(filters.tags),
    states: lowerSet(filters.states),
    unassignedOnly: filters.unassignedOnly,
  };
}

/** Does this card survive every facet of the filter set? */
export function matchesCompiledFilters(
  card: BoardCard,
  filters: CompiledBoardFilters,
): boolean {
  if (filters.projectIds.size > 0 && !filters.projectIds.has(card.project)) {
    return false;
  }
  if (filters.teamIds.size > 0 && !filters.teamIds.has(card.teamId)) {
    return false;
  }
  if (
    filters.workItemTypes.size > 0 &&
    !filters.workItemTypes.has(card.type.trim().toLowerCase())
  ) {
    return false;
  }
  if (
    filters.states.size > 0 &&
    !filters.states.has(card.state.trim().toLowerCase())
  ) {
    return false;
  }
  if (filters.tags.size > 0) {
    const hit = card.tags.some((tag) =>
      filters.tags.has(tag.trim().toLowerCase()),
    );
    if (!hit) return false;
  }
  if (filters.unassignedOnly && !isUnassignedCard(card)) return false;
  return true;
}

/** Single-card form, for callers that hold a `BoardFilterSet` directly. */
export function matchesBoardFilters(
  card: BoardCard,
  filters: BoardFilterSet,
): boolean {
  return matchesCompiledFilters(card, compileBoardFilters(filters));
}

/** Applies the filter set to a snapshot's cards, preserving their order. */
export function applyBoardFilters(
  cards: readonly BoardCard[],
  filters: BoardFilterSet,
): BoardCard[] {
  const compiled = compileBoardFilters(filters);
  return cards.filter((card) => matchesCompiledFilters(card, compiled));
}
