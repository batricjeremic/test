/** The admin screen: board definition, columns, mapping and overrides. */
export { AdminView, default } from './AdminView';
export type { AdminViewProps } from './AdminView';
export { BoardDefinitionForm } from './BoardDefinitionForm';
export type { BoardDefinitionFormProps } from './BoardDefinitionForm';
export { CanonicalColumnsEditor } from './CanonicalColumnsEditor';
export type { CanonicalColumnsEditorProps } from './CanonicalColumnsEditor';
export { MappingMatrix } from './MappingMatrix';
export type { MappingMatrixProps } from './MappingMatrix';
export { PersonOverridesEditor } from './PersonOverridesEditor';
export type { PersonOverridesEditorProps } from './PersonOverridesEditor';
export { SourcesEditor } from './SourcesEditor';
export type { SourcesEditorProps } from './SourcesEditor';
export { UnmappedPanel } from './UnmappedPanel';
export type { UnmappedPanelProps } from './UnmappedPanel';
export { useAdminBoard } from './useAdminBoard';
export type {
  UseAdminBoardOptions,
  UseAdminBoardResult,
} from './useAdminBoard';
export {
  buildAdminTeams,
  findMapping,
  moveColumn,
  namingFromSnapshot,
  newColumnId,
  pruneMappings,
  renumberColumns,
  reorderColumns,
  setMapping,
  setTargetState,
  sortColumns,
  unmappedTeamColumns,
} from './model';
export {
  changedSections,
  normaliseDraft,
  summariseChanges,
  validateDraft,
} from './validation';
export type {
  AdminDraft,
  AdminSection,
  AdminTeam,
  AdminValidationIssue,
  TeamColumnRef,
} from './types';
