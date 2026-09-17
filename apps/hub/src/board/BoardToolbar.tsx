/**
 * Board name, grouping switch, iteration window, live-status pill.
 *
 * Grouping and the window are part of "the board I am looking at", so
 * both go through `useFilters` and land in the URL.
 */
import { useState } from 'react';
import type { BoardGrouping, IterationAlignment } from '@eg/shared';
import type { RealtimeConnectionState } from '../realtime';
import type { UseFiltersResult } from '../state';

export type BoardToolbarProps = {
  boardName: string;
  grouping: BoardGrouping;
  filters: UseFiltersResult;
  realtime: RealtimeConnectionState;
  /** Cards security trimming removed, across every lane. */
  hiddenCardCount: number;
  loading: boolean;
  /** Whether the rolled-up per-person capacity panel is showing. */
  capacityOpen: boolean;
  onToggleCapacity(): void;
  /** True when every lane is already collapsed. */
  allCollapsed: boolean;
  onToggleAllLanes(collapsed: boolean): void;
  onRefresh(): void;
};

export function BoardToolbar({
  boardName,
  grouping,
  filters,
  realtime,
  hiddenCardCount,
  loading,
  capacityOpen,
  onToggleCapacity,
  allCollapsed,
  onToggleAllLanes,
  onRefresh,
}: BoardToolbarProps): JSX.Element {
  return (
    <header className="eg-toolbar">
      <h1 className="eg-lane__title">{boardName}</h1>

      <div
        className="eg-group-toggle"
        role="group"
        aria-label="Group swimlanes by"
      >
        <button
          type="button"
          className="eg-button"
          aria-pressed={grouping === 'person'}
          onClick={() => filters.setGrouping('person')}
        >
          By person
        </button>
        <button
          type="button"
          className="eg-button"
          aria-pressed={grouping === 'team'}
          onClick={() => filters.setGrouping('team')}
        >
          By team
        </button>
      </div>

      <AlignmentPicker
        alignment={filters.alignment}
        onChange={filters.setAlignment}
      />

      <span className="eg-toolbar__spacer" />

      {hiddenCardCount > 0 ? (
        <span className="eg-count">
          {hiddenCardCount} card{hiddenCardCount === 1 ? '' : 's'} hidden by
          permissions
        </span>
      ) : null}

      <span
        className="eg-pill"
        data-tone={realtime.degraded ? 'degraded' : 'live'}
      >
        {realtime.label}
      </span>

      <button
        type="button"
        className="eg-button"
        onClick={() => onToggleAllLanes(!allCollapsed)}
      >
        {allCollapsed ? 'Expand all' : 'Collapse all'}
      </button>

      <button
        type="button"
        className="eg-button"
        aria-expanded={capacityOpen}
        onClick={onToggleCapacity}
      >
        Capacity
      </button>

      <button
        type="button"
        className="eg-button"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </header>
  );
}

type AlignmentPickerProps = {
  alignment: IterationAlignment;
  onChange(alignment: IterationAlignment): void;
};

/**
 * "This sprint" is not one thing when cadences differ, so the choice is
 * explicit rather than guessed.
 */
function AlignmentPicker({
  alignment,
  onChange,
}: AlignmentPickerProps): JSX.Element {
  const [iterationPath, setIterationPath] = useState(
    alignment.mode === 'named-iteration' ? alignment.iterationPath : '',
  );

  const onModeChange = (mode: IterationAlignment['mode']): void => {
    if (mode === 'each-team-current') {
      onChange({ mode });
      return;
    }
    if (mode === 'named-iteration') {
      onChange({ mode, iterationPath: iterationPath || 'Sprint 1' });
      return;
    }
    onChange({ mode, window: defaultDateWindow() });
  };

  return (
    <>
      <label className="eg-field">
        Sprint window
        <select
          value={alignment.mode}
          onChange={(event) =>
            onModeChange(event.target.value as IterationAlignment['mode'])
          }
        >
          <option value="each-team-current">Each team&apos;s current</option>
          <option value="date-window">Date window</option>
          <option value="named-iteration">Named iteration</option>
        </select>
      </label>

      {alignment.mode === 'date-window' ? (
        <>
          <label className="eg-field">
            From
            <input
              type="date"
              value={alignment.window.start}
              onChange={(event) =>
                onChange({
                  mode: 'date-window',
                  window: {
                    start: event.target.value,
                    end: alignment.window.end,
                  },
                })
              }
            />
          </label>
          <label className="eg-field">
            To
            <input
              type="date"
              value={alignment.window.end}
              onChange={(event) =>
                onChange({
                  mode: 'date-window',
                  window: {
                    start: alignment.window.start,
                    end: event.target.value,
                  },
                })
              }
            />
          </label>
        </>
      ) : null}

      {alignment.mode === 'named-iteration' ? (
        <label className="eg-field">
          Iteration
          <input
            type="text"
            value={iterationPath || alignment.iterationPath}
            onChange={(event) => setIterationPath(event.target.value)}
            onBlur={() => {
              if (iterationPath !== '') {
                onChange({ mode: 'named-iteration', iterationPath });
              }
            }}
          />
        </label>
      ) : null}
    </>
  );
}

function defaultDateWindow(): { start: string; end: string } {
  const today = new Date();
  const end = new Date(today.getTime() + 13 * 24 * 60 * 60 * 1000);
  return { start: isoDay(today), end: isoDay(end) };
}

function isoDay(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}
