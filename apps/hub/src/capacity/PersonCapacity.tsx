/**
 * The per-person capacity block, in two variants.
 *
 * `lane` is what the board embeds in a person swimlane header: name,
 * one bar, the hours and the card counts on one line. `summary` is the
 * fuller block the capacity panel renders, with every marker spelled
 * out. Both read the same `PersonLoad` and the same derived figures, so
 * the two can never disagree.
 */
import { useCallback, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PersonLoad, PersonTeamCapacity } from '@eg/shared';
import { CapacityBar } from './CapacityBar';
import { deriveCapacityFigures, formatHours } from './load';
import type { CapacityFigures, CapacityMarker } from './load';
import './capacity.css';

export type PersonCapacityVariant = 'lane' | 'summary';

export type PersonCapacityProps = {
  readonly person: PersonLoad;
  /** `lane` for a swimlane header, `summary` for the capacity panel. */
  readonly variant?: PersonCapacityVariant;
  /** Load at or above this counts as over. Defaults to the shared 1.0. */
  readonly threshold?: number;
  /** Set false in a lane where the board already prints the name. */
  readonly showName?: boolean;
};

function MarkerList({
  markers,
  variant,
}: {
  readonly markers: readonly CapacityMarker[];
  readonly variant: PersonCapacityVariant;
}): JSX.Element | null {
  if (markers.length === 0) return null;
  return (
    <ul className="eg-capacity__markers">
      {markers.map((marker) => (
        <li
          key={marker.kind}
          className="eg-capacity__marker"
          data-kind={marker.kind}
          title={marker.detail}
        >
          <span>{marker.label}</span>
          {variant === 'summary' ? (
            <span className="eg-visually-hidden">{marker.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function teamDaysLabel(team: PersonTeamCapacity): string {
  const worked = Math.max(0, team.workingDays - team.daysOff);
  return `${worked} of ${team.workingDays}`;
}

function PerTeamSplit({
  figures,
  perTeam,
}: {
  readonly figures: CapacityFigures;
  readonly perTeam: readonly PersonTeamCapacity[];
}): JSX.Element | null {
  const panelId = useId();
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const [pinned, setPinned] = useState(false);

  const close = useCallback(() => {
    setPinned(false);
    setHovered(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') close();
    },
    [close],
  );

  if (perTeam.length === 0) return null;
  const open = hovered || focusedWithin || pinned;

  return (
    <div
      className="eg-capacity__split"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusedWithin(true)}
      onBlur={() => setFocusedWithin(false)}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="eg-capacity__split-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setPinned((value) => !value)}
      >
        {`Per-team split (${perTeam.length})`}
      </button>
      <div
        id={panelId}
        className="eg-capacity__split-panel"
        role="group"
        aria-label={`Per-team split for ${figures.displayName}`}
        hidden={!open}
      >
        <table className="eg-capacity__split-table">
          <caption className="eg-visually-hidden">
            {`Capacity and committed hours per team for ${figures.displayName}`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Days</th>
              <th scope="col">Capacity</th>
              <th scope="col">Committed</th>
              <th scope="col">Cards</th>
            </tr>
          </thead>
          <tbody>
            {perTeam.map((team) => (
              <tr key={`${team.teamId}:${team.iterationId}`}>
                <th scope="row">
                  {team.teamName}
                  {team.hasCapacityRecord ? null : (
                    <span
                      className="eg-capacity__marker"
                      data-kind="partial-capacity"
                    >
                      No capacity record
                    </span>
                  )}
                </th>
                <td>{teamDaysLabel(team)}</td>
                <td>
                  {team.hasCapacityRecord
                    ? `${formatHours(team.capacityHours)} h`
                    : '—'}
                </td>
                <td>{`${formatHours(team.committedHours)} h`}</td>
                <td>{team.cardCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Name, bar, numbers and markers for exactly one person. */
export function PersonCapacity({
  person,
  variant = 'summary',
  threshold,
  showName = true,
}: PersonCapacityProps): JSX.Element {
  const figures = deriveCapacityFigures(person, { threshold });
  return (
    <div
      className="eg-capacity"
      data-variant={variant}
      data-over={figures.over ? 'true' : 'false'}
      data-descriptor={figures.descriptor}
    >
      <div className="eg-capacity__heading">
        {showName ? (
          <span className="eg-capacity__name">{figures.displayName}</span>
        ) : null}
        <span
          className="eg-capacity__load"
          data-over={figures.over ? 'true' : 'false'}
          data-unknown={figures.hasCapacity ? 'false' : 'true'}
        >
          {figures.loadLabel}
        </span>
      </div>
      <CapacityBar figures={figures} />
      <div className="eg-capacity__meta">
        <span>{figures.hoursLabel}</span>
        <span>{figures.cardsLabel}</span>
        <PerTeamSplit figures={figures} perTeam={person.perTeam} />
      </div>
      <MarkerList markers={figures.markers} variant={variant} />
    </div>
  );
}

export default PersonCapacity;
