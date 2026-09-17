/**
 * Canonical columns: create, rename, reorder and categorise.
 *
 * Reordering works with a pointer (dnd-kit) and from the keyboard
 * (dnd-kit's keyboard sensor on the handle, plus explicit move buttons).
 * A board that can only be configured with a mouse is not configurable.
 */
import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { STATE_CATEGORIES, stateCategorySchema } from '@eg/shared';
import type { CanonicalColumn, StateCategory } from '@eg/shared';
import {
  moveColumn,
  newColumnId,
  pruneMappings,
  renumberColumns,
  reorderColumns,
  sortColumns,
} from './model';
import type { AdminDraft } from './types';

export type CanonicalColumnsEditorProps = {
  readonly draft: AdminDraft;
  readonly update: (patch: (draft: AdminDraft) => AdminDraft) => void;
};

const CATEGORY_HINT: Record<StateCategory, string> = {
  Proposed: 'Not started',
  InProgress: 'In flight',
  Completed: 'Finished',
};

type ColumnRowProps = {
  readonly column: CanonicalColumn;
  readonly index: number;
  readonly total: number;
  readonly onRename: (id: string, name: string) => void;
  readonly onCategory: (id: string, category: StateCategory) => void;
  readonly onMove: (id: string, delta: number) => void;
  readonly onRemove: (id: string) => void;
};

function ColumnRow({
  column,
  index,
  total,
  onRename,
  onCategory,
  onMove,
  onRemove,
}: ColumnRowProps): JSX.Element {
  const sortable = useSortable({ id: column.id });
  // `@dnd-kit/utilities` is not a dependency of the hub, and its only job
  // here is this one string.
  const { transform, transition } = sortable;
  const style: CSSProperties = {
    transform:
      transform === null
        ? undefined
        : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    transition: transition ?? undefined,
  };

  return (
    <tr
      ref={sortable.setNodeRef}
      style={style}
      className="eg-admin__column-row"
      data-dragging={sortable.isDragging ? 'true' : 'false'}
    >
      <td className="eg-admin__order">
        <button
          type="button"
          className="eg-button eg-admin__handle"
          aria-label={`Reorder ${column.name} by dragging`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          ⠿
        </button>
        <span> {index + 1}</span>
      </td>
      <th scope="row">
        <label className="eg-admin__field">
          <span className="eg-visually-hidden">
            {`Name of column ${index + 1}`}
          </span>
          <input
            type="text"
            value={column.name}
            aria-label={`Name of column ${index + 1}`}
            onChange={(event) => onRename(column.id, event.target.value)}
          />
        </label>
      </th>
      <td>
        <label className="eg-admin__field">
          <span className="eg-visually-hidden">
            {`State category of ${column.name}`}
          </span>
          <select
            value={column.stateCategory}
            aria-label={`State category of ${column.name}`}
            onChange={(event) => {
              const parsed = stateCategorySchema.safeParse(event.target.value);
              if (parsed.success) onCategory(column.id, parsed.data);
            }}
          >
            {STATE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {`${category} — ${CATEGORY_HINT[category]}`}
              </option>
            ))}
          </select>
        </label>
      </td>
      <td>
        <div className="eg-row">
          <button
            type="button"
            className="eg-button"
            disabled={index === 0}
            aria-label={`Move ${column.name} earlier`}
            onClick={() => onMove(column.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="eg-button"
            disabled={index === total - 1}
            aria-label={`Move ${column.name} later`}
            onClick={() => onMove(column.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="eg-button"
            aria-label={`Remove ${column.name}`}
            onClick={() => onRemove(column.id)}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

export function CanonicalColumnsEditor({
  draft,
  update,
}: CanonicalColumnsEditorProps): JSX.Element {
  const [pendingName, setPendingName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const newColumnInputId = useId();
  const columns = sortColumns(draft.columns);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const announce = (next: readonly CanonicalColumn[], id: string): void => {
    const position = next.findIndex((column) => column.id === id);
    const moved = next[position];
    if (!moved) return;
    setAnnouncement(
      `${moved.name} is now column ${position + 1} of ${next.length}.`,
    );
  };

  const onMove = (id: string, delta: number): void => {
    const next = moveColumn(draft.columns, id, delta);
    announce(next, id);
    update((current) => ({ ...current, columns: next }));
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const overId = event.over?.id;
    if (overId === undefined || overId === event.active.id) return;
    const next = reorderColumns(
      draft.columns,
      String(event.active.id),
      String(overId),
    );
    announce(next, String(event.active.id));
    update((current) => ({ ...current, columns: next }));
  };

  const onRename = (id: string, name: string): void => {
    update((current) => ({
      ...current,
      columns: current.columns.map((column) =>
        column.id === id ? { ...column, name } : column,
      ),
    }));
  };

  const onCategory = (id: string, stateCategory: StateCategory): void => {
    update((current) => ({
      ...current,
      columns: current.columns.map((column) =>
        column.id === id ? { ...column, stateCategory } : column,
      ),
    }));
  };

  const onRemove = (id: string): void => {
    update((current) => {
      const next = renumberColumns(
        sortColumns(current.columns).filter((column) => column.id !== id),
      );
      return {
        ...current,
        columns: next,
        mappings: pruneMappings(current.mappings, current.sources, next),
      };
    });
  };

  const addColumn = (): void => {
    const name = pendingName.trim();
    if (name === '') return;
    update((current) => {
      const ordered = sortColumns(current.columns);
      const added: CanonicalColumn = {
        id: newColumnId(name, ordered),
        boardId: current.definition.id,
        name,
        order: ordered.length,
        stateCategory: 'InProgress',
      };
      return { ...current, columns: [...ordered, added] };
    });
    setPendingName('');
  };

  return (
    <section
      className="eg-panel eg-admin__section"
      aria-labelledby="eg-admin-columns-heading"
    >
      <h2 id="eg-admin-columns-heading">Canonical columns</h2>
      <p className="eg-admin__hint">
        The columns everyone sees, left to right. Each team&rsquo;s own board
        columns are mapped onto these below. The state category is what the
        board treats as not started, in flight and finished.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <table className="eg-admin__table">
          <caption>Canonical columns in board order</caption>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Name</th>
              <th scope="col">State category</th>
              <th scope="col">
                <span className="eg-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <SortableContext
            items={columns.map((column) => column.id)}
            strategy={verticalListSortingStrategy}
          >
            <tbody>
              {columns.map((column, index) => (
                <ColumnRow
                  key={column.id}
                  column={column}
                  index={index}
                  total={columns.length}
                  onRename={onRename}
                  onCategory={onCategory}
                  onMove={onMove}
                  onRemove={onRemove}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
      <p
        className="eg-visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="column-order-status"
      >
        {announcement}
      </p>
      <div className="eg-row">
        <label className="eg-admin__field" htmlFor={newColumnInputId}>
          <span>New column name</span>
        </label>
        <input
          id={newColumnInputId}
          type="text"
          value={pendingName}
          onChange={(event) => setPendingName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addColumn();
            }
          }}
        />
        <button
          type="button"
          className="eg-button"
          disabled={pendingName.trim() === ''}
          onClick={addColumn}
        >
          Add column
        </button>
      </div>
    </section>
  );
}

export default CanonicalColumnsEditor;
