/**
 * Board-connected capacity access.
 *
 * The snapshot already carries one `PersonLoad` per person in scope,
 * whatever the grouping, so these hooks only select from it. They must be
 * called under a `BoardProvider`; the components take plain props so they
 * stay testable without one.
 */
import { useMemo } from 'react';
import type { PersonLoad } from '@eg/shared';
import { useBoardContext } from '../state';
import { findPersonLoad, sortPeopleByLoad } from './load';

/** Visible people, heaviest first. */
export function usePersonLoads(): readonly PersonLoad[] {
  const { personLoad } = useBoardContext();
  return useMemo(() => sortPeopleByLoad(personLoad), [personLoad]);
}

/** The load for one swimlane's person, or null for the unassigned lane. */
export function usePersonLoad(descriptor: string | null): PersonLoad | null {
  const { personLoad } = useBoardContext();
  return useMemo(
    () => findPersonLoad(personLoad, descriptor),
    [personLoad, descriptor],
  );
}
