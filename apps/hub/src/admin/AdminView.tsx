/**
 * The admin screen.
 *
 * The spec is explicit that column mapping is owned by a human and
 * configured once. This screen is where that happens, and its whole job
 * is making misconfiguration visible instead of silent: the unmapped
 * count is the first thing on it, and saving validates before it writes,
 * says what it wrote, and refuses to pretend a failed write succeeded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardDefinition } from '@eg/shared';
import { describeApiError, useApiClient } from '../api';
import type { BoardApiClient } from '../api';
import { useOptionalHubHost } from '../sdk';
import { BffEndpointPanel } from './BffEndpointPanel';
import { BoardDefinitionForm } from './BoardDefinitionForm';
import { CanonicalColumnsEditor } from './CanonicalColumnsEditor';
import { MappingMatrix } from './MappingMatrix';
import { PersonOverridesEditor } from './PersonOverridesEditor';
import { SourcesEditor } from './SourcesEditor';
import { useAdminBoard } from './useAdminBoard';
import { UnmappedPanel } from './UnmappedPanel';
import './admin.css';

export type AdminViewProps = {
  /** Overrides the client from `<ApiProvider>`. Tests inject the fake. */
  readonly client?: BoardApiClient;
  /** Opens on this board instead of the first one. */
  readonly initialBoardId?: string;
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'board'
  );
}

export function AdminView({
  client: injected,
  initialBoardId,
}: AdminViewProps = {}): JSX.Element {
  const fallbackClient = useApiClient();
  const client = injected ?? fallbackClient;
  const host = useOptionalHubHost();

  const [definitions, setDefinitions] = useState<readonly BoardDefinition[]>(
    [],
  );
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [listError, setListError] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(initialBoardId ?? null);
  const abortRef = useRef<AbortController | null>(null);

  const loadDefinitions = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setListStatus('loading');
    setListError(null);
    try {
      const found = await client.listBoardDefinitions({
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setDefinitions(found);
      setListStatus('ready');
      setBoardId((current) => {
        if (current !== null && found.some((entry) => entry.id === current)) {
          return current;
        }
        return found[0]?.id ?? null;
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setListError(describeApiError(error));
      setListStatus('error');
    }
  }, [client]);

  useEffect(() => {
    void loadDefinitions();
    return () => abortRef.current?.abort();
  }, [loadDefinitions]);

  const board = useAdminBoard(boardId, { client });
  const { draft, issues, changes, savedChanges } = board;

  const blocking = issues.length > 0;
  const issueList = useMemo(
    () => issues.map((issue) => `${issue.section}: ${issue.message}`),
    [issues],
  );

  const createBoard = async (): Promise<void> => {
    const context = host?.context;
    if (!context) return;
    const name = `New board ${definitions.length + 1}`;
    const definition: BoardDefinition = {
      id: `${slugify(name)}-${Date.now()}`,
      name,
      orgId: context.organizationId,
      defaultGrouping: 'person',
      ownerDescriptor: context.userDescriptor,
    };
    try {
      const created = await client.createBoardDefinition(definition);
      setDefinitions((current) => [...current, created]);
      setBoardId(created.id);
      setListError(null);
    } catch (error) {
      setListError(describeApiError(error));
    }
  };

  return (
    <div className="eg-hub eg-admin">
      <header className="eg-toolbar eg-admin__savebar">
        <h1 className="eg-admin__title">Board administration</h1>
        <label className="eg-admin__field">
          <span>Board</span>
          <select
            value={boardId ?? ''}
            disabled={definitions.length === 0}
            onChange={(event) => setBoardId(event.target.value)}
          >
            {definitions.length === 0 ? (
              <option value="">No boards yet</option>
            ) : (
              definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.name}
                </option>
              ))
            )}
          </select>
        </label>
        {host === null ? null : (
          <button type="button" className="eg-button" onClick={createBoard}>
            New board
          </button>
        )}
        <span className="eg-toolbar__spacer" />
        {board.dirty ? (
          <span className="eg-pill" data-tone="degraded">
            Unsaved changes
          </span>
        ) : null}
        {board.saving ? (
          <span className="eg-spinner" aria-hidden="true" />
        ) : null}
        <button
          type="button"
          className="eg-button"
          data-variant="primary"
          disabled={draft === null || board.saving || !board.dirty || blocking}
          onClick={() => void board.save()}
        >
          {board.saving ? 'Saving…' : 'Save changes'}
        </button>
      </header>

      <div className="eg-admin__status" role="status" aria-live="polite">
        {listStatus === 'loading' ? <p>Loading boards…</p> : null}
        {board.status === 'loading' ? (
          <p>Loading this board&rsquo;s configuration…</p>
        ) : null}
        {savedChanges !== null ? (
          savedChanges.length === 0 ? (
            <p>Nothing to save: this board already matches the form.</p>
          ) : (
            <>
              <p>{`Saved. ${savedChanges.length} change${
                savedChanges.length === 1 ? '' : 's'
              } written:`}</p>
              <ul className="eg-admin__changes">
                {savedChanges.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )
        ) : null}
        {!board.saving && savedChanges === null && changes.length > 0 ? (
          <>
            <p>{`${changes.length} unsaved change${
              changes.length === 1 ? '' : 's'
            }:`}</p>
            <ul className="eg-admin__changes">
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {listError !== null ||
      board.loadErrorMessage !== null ||
      board.saveErrorMessage !== null ? (
        <div
          className="eg-panel eg-admin__status"
          data-tone="error"
          role="alert"
        >
          {listError !== null ? <p>{listError}</p> : null}
          {board.loadErrorMessage !== null ? (
            <>
              <p>{board.loadErrorMessage}</p>
              <button
                type="button"
                className="eg-button"
                onClick={() => void board.reload()}
              >
                Try again
              </button>
            </>
          ) : null}
          {board.saveErrorMessage !== null ? (
            <p>
              {`Not saved: ${board.saveErrorMessage} Your changes are still on this screen — fix the cause and save again.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {blocking ? (
        <div className="eg-panel" role="alert">
          <h2>This board cannot be saved yet</h2>
          <ul className="eg-admin__issues">
            {issueList.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft === null ? (
        listStatus === 'ready' && definitions.length === 0 ? (
          <section className="eg-panel">
            <h2>No boards yet</h2>
            <p className="eg-admin__hint">
              A board is a saved definition: the projects and teams it covers,
              its canonical columns, and the mapping from each team&rsquo;s own
              columns onto them.
            </p>
          </section>
        ) : null
      ) : (
        <>
          <UnmappedPanel unmapped={board.unmapped} />
          <BoardDefinitionForm draft={draft} update={board.update} />
          <SourcesEditor draft={draft} update={board.update} />
          <CanonicalColumnsEditor draft={draft} update={board.update} />
          <MappingMatrix
            draft={draft}
            teams={board.teams}
            update={board.update}
            addTeamColumn={board.addTeamColumn}
          />
          <PersonOverridesEditor draft={draft} update={board.update} />
        </>
      )}

      {/*
        Organisation-level, not board-level: it is shown whether or not a
        board is selected, and only when there is a host to read and write
        the setting through.
      */}
      {host === null ? null : <BffEndpointPanel />}
    </div>
  );
}

export default AdminView;
