/**
 * The filter bar: project, team, work item type, tag, state and
 * unassigned, straight onto `useFilters` — which keeps them in the URL,
 * so a filtered board is a link somebody can paste into a chat.
 *
 * Options come from what the snapshot actually contains, plus anything
 * already selected, so a facet can never strand a filter the user cannot
 * see to clear.
 */
import { useMemo, useState } from 'react';
import type { BoardCard, BoardTeamView } from '@eg/shared';
import type { ListFilterKey, UseFiltersResult } from '../state';

export type FilterBarProps = {
  filters: UseFiltersResult;
  teams: readonly BoardTeamView[];
  cards: readonly BoardCard[];
};

type Option = { value: string; label: string };

type Facet = {
  key: ListFilterKey;
  legend: string;
  options: readonly Option[];
};

export function FilterBar({
  filters,
  teams,
  cards,
}: FilterBarProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const facets = useMemo<readonly Facet[]>(
    () => [
      {
        key: 'projectIds',
        legend: 'Project',
        options: withSelected(
          dedupe(
            teams.map((team) => ({
              value: team.projectId,
              label: team.iteration.projectName || team.projectId,
            })),
          ),
          filters.filters.projectIds,
        ),
      },
      {
        key: 'teamIds',
        legend: 'Team',
        options: withSelected(
          dedupe(
            teams.map((team) => ({
              value: team.teamId,
              label: team.iteration.teamName || team.teamId,
            })),
          ),
          filters.filters.teamIds,
        ),
      },
      {
        key: 'workItemTypes',
        legend: 'Work item type',
        options: withSelected(
          valueOptions(cards.map((card) => card.type)),
          filters.filters.workItemTypes,
        ),
      },
      {
        key: 'tags',
        legend: 'Tag',
        options: withSelected(
          valueOptions(cards.flatMap((card) => card.tags)),
          filters.filters.tags,
        ),
      },
      {
        key: 'states',
        legend: 'State',
        options: withSelected(
          valueOptions(cards.map((card) => card.state)),
          filters.filters.states,
        ),
      },
    ],
    [teams, cards, filters.filters],
  );

  return (
    <section className="eg-panel" aria-label="Board filters">
      <div className="eg-row">
        <button
          type="button"
          className="eg-button"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
        >
          Filters
          {filters.activeFilterCount > 0
            ? ` (${filters.activeFilterCount})`
            : ''}
        </button>

        <label className="eg-check">
          <input
            type="checkbox"
            checked={filters.filters.unassignedOnly}
            onChange={(event) =>
              filters.setUnassignedOnly(event.target.checked)
            }
          />
          Unassigned only
        </label>

        <span className="eg-toolbar__spacer" />

        <button
          type="button"
          className="eg-button"
          onClick={filters.clearFilters}
          disabled={!filters.isFiltered}
        >
          Clear filters
        </button>
      </div>

      {open ? (
        <div className="eg-filters">
          {facets.map((facet) => (
            <fieldset key={facet.key}>
              <legend>{facet.legend}</legend>
              <div className="eg-filters__options">
                {facet.options.length === 0 ? (
                  <span className="eg-count">Nothing to filter on</span>
                ) : (
                  facet.options.map((option) => (
                    <label className="eg-check" key={option.value}>
                      <input
                        type="checkbox"
                        checked={filters.filters[facet.key].includes(
                          option.value,
                        )}
                        onChange={() =>
                          filters.toggleFilterValue(facet.key, option.value)
                        }
                      />
                      {option.label}
                    </label>
                  ))
                )}
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function dedupe(options: readonly Option[]): Option[] {
  const byValue = new Map<string, Option>();
  for (const option of options) {
    if (!byValue.has(option.value)) byValue.set(option.value, option);
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function valueOptions(values: readonly string[]): Option[] {
  return dedupe(
    values
      .filter((value) => value !== '')
      .map((value) => ({ value, label: value })),
  );
}

function withSelected(
  options: readonly Option[],
  selected: readonly string[],
): Option[] {
  const known = new Set(options.map((option) => option.value));
  const extra = selected
    .filter((value) => !known.has(value))
    .map((value) => ({ value, label: value }));
  return [...options, ...extra];
}
