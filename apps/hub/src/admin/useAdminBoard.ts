/**
 * Loads one board's configuration, holds the draft, and writes it back.
 *
 * Reads and writes both go through the typed BFF client, so every call
 * already carries a bearer token, a correlation id and a timeout. The
 * hook never reports a save as done unless the BFF confirmed it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardDefinition,
  BoardSnapshot,
  BoardSource,
  CanonicalColumn,
  ColumnMapping,
  PersonOverride,
} from '@eg/shared';
import { DEFAULT_BOARD_QUERY, describeApiError, useApiClient } from '../api';
import type { BoardApiClient } from '../api';
import {
  buildAdminTeams,
  namingFromSnapshot,
  unmappedTeamColumns,
} from './model';
import {
  changedSections,
  normaliseDraft,
  summariseChanges,
  validateDraft,
} from './validation';
import type {
  AdminDraft,
  AdminTeam,
  AdminValidationIssue,
  TeamColumnRef,
} from './types';

export type UseAdminBoardOptions = {
  /** Overrides the client from `<ApiProvider>`; tests inject the fake. */
  client?: BoardApiClient;
  /** False while no board is selected. */
  enabled?: boolean;
};

export type UseAdminBoardResult = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadErrorMessage: string | null;
  draft: AdminDraft | null;
  teams: readonly AdminTeam[];
  /** Team columns with no mapping row: the number that must reach zero. */
  unmapped: readonly TeamColumnRef[];
  issues: readonly AdminValidationIssue[];
  changes: readonly string[];
  dirty: boolean;
  saving: boolean;
  saveErrorMessage: string | null;
  /** What the last successful save actually wrote. */
  savedChanges: readonly string[] | null;
  update(patch: (draft: AdminDraft) => AdminDraft): void;
  /** Teaches the matrix about a column we have not seen cards or rows for. */
  addTeamColumn(teamId: string, sourceColumnId: string): void;
  reload(): Promise<void>;
  save(): Promise<void>;
};

type LoadedState = {
  saved: AdminDraft;
  snapshot: BoardSnapshot | null;
};

function toDraft(
  definition: BoardDefinition,
  sources: readonly BoardSource[],
  columns: readonly CanonicalColumn[],
  mappings: readonly ColumnMapping[],
  overrides: readonly PersonOverride[],
): AdminDraft {
  return normaliseDraft({
    definition,
    sources: [...sources],
    columns: [...columns],
    mappings: [...mappings],
    overrides: [...overrides],
  });
}

export function useAdminBoard(
  boardId: string | null,
  options: UseAdminBoardOptions = {},
): UseAdminBoardResult {
  const fallbackClient = useApiClient();
  const client = options.client ?? fallbackClient;
  const enabled = options.enabled !== false && boardId !== null;

  const [status, setStatus] = useState<UseAdminBoardResult['status']>('idle');
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [draft, setDraft] = useState<AdminDraft | null>(null);
  const [extraColumns, setExtraColumns] = useState<readonly TeamColumnRef[]>(
    [],
  );
  const [saving, setSaving] = useState(false);
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [savedChanges, setSavedChanges] = useState<readonly string[] | null>(
    null,
  );

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!enabled || boardId === null) {
      setStatus('idle');
      setLoaded(null);
      setDraft(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setStatus('loading');
    setLoadErrorMessage(null);
    setSaveErrorMessage(null);
    setSavedChanges(null);

    try {
      const [definition, sources, columns, mappings, overrides] =
        await Promise.all([
          client.getBoardDefinition(boardId, { signal }),
          client.listBoardSources(boardId, { signal }),
          client.listCanonicalColumns(boardId, { signal }),
          client.listColumnMappings(boardId, { signal }),
          client.listPersonOverrides(boardId, { signal }),
        ]);

      // The snapshot is only here for team names and stranded-card counts.
      // A board whose snapshot cannot be built must still be configurable,
      // so this failure is swallowed on purpose.
      let snapshot: BoardSnapshot | null = null;
      try {
        snapshot = await client.getBoardSnapshot(boardId, DEFAULT_BOARD_QUERY, {
          signal,
        });
      } catch {
        snapshot = null;
      }

      if (signal.aborted) return;
      const next = toDraft(definition, sources, columns, mappings, overrides);
      setLoaded({ saved: next, snapshot });
      setDraft(next);
      setExtraColumns([]);
      setStatus('ready');
    } catch (error) {
      if (signal.aborted) return;
      setLoadErrorMessage(describeApiError(error));
      setStatus('error');
    }
  }, [boardId, client, enabled]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const update = useCallback((patch: (current: AdminDraft) => AdminDraft) => {
    setSavedChanges(null);
    setDraft((current) => (current === null ? current : patch(current)));
  }, []);

  const addTeamColumn = useCallback(
    (teamId: string, sourceColumnId: string) => {
      const trimmed = sourceColumnId.trim();
      if (trimmed === '') return;
      setExtraColumns((current) =>
        current.some(
          (column) =>
            column.teamId === teamId && column.sourceColumnId === trimmed,
        )
          ? current
          : [
              ...current,
              {
                teamId,
                projectId: '',
                teamName: '',
                projectName: '',
                sourceColumnId: trimmed,
                cardCount: 0,
              },
            ],
      );
    },
    [],
  );

  const teams = useMemo(
    () =>
      draft === null
        ? []
        : buildAdminTeams(
            draft.sources,
            draft.mappings,
            loaded?.snapshot?.unmappedColumns ?? [],
            namingFromSnapshot(loaded?.snapshot ?? null),
            extraColumns,
          ),
    [draft, loaded, extraColumns],
  );

  const unmapped = useMemo(
    () => (draft === null ? [] : unmappedTeamColumns(teams, draft.mappings)),
    [teams, draft],
  );

  const issues = useMemo(
    () => (draft === null ? [] : validateDraft(draft)),
    [draft],
  );

  const changes = useMemo(
    () =>
      draft === null || loaded === null
        ? []
        : summariseChanges(loaded.saved, draft),
    [draft, loaded],
  );

  const dirty = useMemo(
    () =>
      draft === null || loaded === null
        ? false
        : changedSections(loaded.saved, draft).length > 0,
    [draft, loaded],
  );

  const save = useCallback(async (): Promise<void> => {
    if (draft === null || loaded === null || boardId === null) return;
    setSavedChanges(null);
    if (validateDraft(draft).length > 0) {
      setSaveErrorMessage(
        'Nothing was saved: fix the problems listed above first.',
      );
      return;
    }

    const next = normaliseDraft(draft);
    const sections = changedSections(loaded.saved, next);
    if (sections.length === 0) {
      setSaveErrorMessage(null);
      setSavedChanges([]);
      return;
    }

    const summary = summariseChanges(loaded.saved, next);
    setSaving(true);
    setSaveErrorMessage(null);

    // Each section is a whole-set PUT. Sections that land are promoted to
    // the baseline as they land, so a retry after a failure only rewrites
    // what is still outstanding.
    let baseline = loaded.saved;
    const promote = (value: Partial<AdminDraft>): void => {
      baseline = { ...baseline, ...value };
    };

    try {
      if (sections.includes('definition')) {
        const written = await client.updateBoardDefinition(next.definition);
        promote({ definition: written });
      }
      if (sections.includes('sources')) {
        const written = await client.replaceBoardSources(boardId, next.sources);
        promote({ sources: written });
      }
      if (sections.includes('columns')) {
        const written = await client.replaceCanonicalColumns(
          boardId,
          next.columns,
        );
        promote({ columns: written });
      }
      if (sections.includes('mappings')) {
        const written = await client.replaceColumnMappings(
          boardId,
          next.mappings,
        );
        promote({ mappings: written });
      }
      if (sections.includes('overrides')) {
        const written = await client.replacePersonOverrides(
          boardId,
          next.overrides,
        );
        promote({ overrides: written });
      }
      const settled = normaliseDraft(baseline);
      setLoaded({ saved: settled, snapshot: loaded.snapshot });
      setDraft(settled);
      setSavedChanges(summary);
    } catch (error) {
      setLoaded({ saved: normaliseDraft(baseline), snapshot: loaded.snapshot });
      setSaveErrorMessage(describeApiError(error));
    } finally {
      setSaving(false);
    }
  }, [boardId, client, draft, loaded]);

  return {
    status,
    loadErrorMessage,
    draft,
    teams,
    unmapped,
    issues,
    changes,
    dirty,
    saving,
    saveErrorMessage,
    savedChanges,
    update,
    addTeamColumn,
    reload: load,
    save,
  };
}
