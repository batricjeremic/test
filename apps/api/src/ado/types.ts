/**
 * Raw Azure DevOps REST 7.1 response shapes, one group per endpoint in
 * the spec's "Azure DevOps API surface" tables, each with the Zod schema
 * the client parses responses through.
 *
 * Nothing here is a domain type. The ADO client returns these; the
 * domain layer maps them onto the DTOs in `@eg/shared`.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

/** `_links` is an open bag we never depend on. */
export const adoLinksSchema = z.record(z.unknown());

/** Collections come back as `{ count, value }` everywhere in 7.1. */
export const adoListSchema = <TItem extends z.ZodTypeAny>(item: TItem) =>
  z.object({
    count: z.number().int().nonnegative(),
    value: z.array(item),
  });

/**
 * Identity reference. `descriptor` is the stable per-organization id we
 * key people on; `displayName` and `uniqueName` are personal data.
 */
export const adoIdentityRefSchema = z.object({
  id: z.string().optional(),
  descriptor: z.string().optional(),
  displayName: z.string().optional(),
  uniqueName: z.string().optional(),
  imageUrl: z.string().optional(),
  url: z.string().optional(),
});
export type AdoIdentityRef = z.infer<typeof adoIdentityRefSchema>;

/** Inclusive `{ start, end }` date range, as days off are expressed. */
export const adoDateRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
});
export type AdoDateRange = z.infer<typeof adoDateRangeSchema>;

export const adoFieldReferenceSchema = z.object({
  referenceName: z.string(),
  url: z.string().optional(),
});
export type AdoFieldReference = z.infer<typeof adoFieldReferenceSchema>;

/* ------------------------------------------------------------------ */
/* GET /_apis/projects                                                 */
/* ------------------------------------------------------------------ */

export const adoTeamProjectReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  url: z.string().optional(),
  /** `wellFormed`, `createPending`, ... Left open for forward numbers. */
  state: z.string().optional(),
  revision: z.number().optional(),
  visibility: z.string().optional(),
  lastUpdateTime: z.string().optional(),
});
export type AdoTeamProjectReference = z.infer<
  typeof adoTeamProjectReferenceSchema
>;
export const adoProjectListSchema = adoListSchema(
  adoTeamProjectReferenceSchema,
);
export type AdoProjectList = z.infer<typeof adoProjectListSchema>;

/* ------------------------------------------------------------------ */
/* GET /_apis/projects/{projectId}/teams                               */
/* ------------------------------------------------------------------ */

export const adoWebApiTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  description: z.string().optional(),
  identityUrl: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
});
export type AdoWebApiTeam = z.infer<typeof adoWebApiTeamSchema>;
export const adoTeamListSchema = adoListSchema(adoWebApiTeamSchema);
export type AdoTeamList = z.infer<typeof adoTeamListSchema>;

/* ------------------------------------------------------------------ */
/* GET /{project}/{team}/_apis/work/teamsettings/teamfieldvalues       */
/* The team's area paths: how a card resolves to its owning team.      */
/* ------------------------------------------------------------------ */

export const adoTeamFieldValueSchema = z.object({
  value: z.string(),
  includeChildren: z.boolean(),
});
export type AdoTeamFieldValue = z.infer<typeof adoTeamFieldValueSchema>;

export const adoTeamFieldValuesSchema = z.object({
  field: adoFieldReferenceSchema,
  defaultValue: z.string(),
  values: z.array(adoTeamFieldValueSchema),
  _links: adoLinksSchema.optional(),
  url: z.string().optional(),
});
export type AdoTeamFieldValues = z.infer<typeof adoTeamFieldValuesSchema>;

/* ------------------------------------------------------------------ */
/* GET .../teamsettings/iterations?$timeframe=current                  */
/* ------------------------------------------------------------------ */

/** Only `current` is used on the hot path; the type is the API's own. */
export const adoIterationTimeframeSchema = z.enum([
  'past',
  'current',
  'future',
]);
export type AdoIterationTimeframe = z.infer<typeof adoIterationTimeframeSchema>;

export const adoIterationAttributesSchema = z.object({
  startDate: z.string().nullable(),
  finishDate: z.string().nullable(),
  timeFrame: z.string().optional(),
});
export type AdoIterationAttributes = z.infer<
  typeof adoIterationAttributesSchema
>;

export const adoTeamSettingsIterationSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  attributes: adoIterationAttributesSchema.nullable().optional(),
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoTeamSettingsIteration = z.infer<
  typeof adoTeamSettingsIterationSchema
>;
export const adoIterationListSchema = adoListSchema(
  adoTeamSettingsIterationSchema,
);
export type AdoIterationList = z.infer<typeof adoIterationListSchema>;

/* ------------------------------------------------------------------ */
/* GET .../iterations/{iterationId}/workitems                          */
/* ------------------------------------------------------------------ */

export const adoWorkItemReferenceSchema = z.object({
  id: z.number().int(),
  url: z.string().optional(),
});
export type AdoWorkItemReference = z.infer<typeof adoWorkItemReferenceSchema>;

export const adoWorkItemLinkSchema = z.object({
  rel: z.string().nullable(),
  source: adoWorkItemReferenceSchema.nullable(),
  target: adoWorkItemReferenceSchema,
});
export type AdoWorkItemLink = z.infer<typeof adoWorkItemLinkSchema>;

export const adoIterationWorkItemsSchema = z.object({
  workItemRelations: z.array(adoWorkItemLinkSchema),
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoIterationWorkItems = z.infer<typeof adoIterationWorkItemsSchema>;

/* ------------------------------------------------------------------ */
/* GET .../work/boards  and  GET .../work/boards/{id}                  */
/* ------------------------------------------------------------------ */

export const adoBoardReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
});
export type AdoBoardReference = z.infer<typeof adoBoardReferenceSchema>;
export const adoBoardListSchema = adoListSchema(adoBoardReferenceSchema);
export type AdoBoardList = z.infer<typeof adoBoardListSchema>;

/** `incoming` and `outgoing` are the first and last columns. */
export const adoBoardColumnTypeSchema = z.enum([
  'incoming',
  'inProgress',
  'outgoing',
]);
export type AdoBoardColumnType = z.infer<typeof adoBoardColumnTypeSchema>;

export const adoBoardColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  itemLimit: z.number().int().nonnegative().optional(),
  /** Work item type -> state bound to this column, when one is bound. */
  stateMappings: z.record(z.string()).optional(),
  columnType: adoBoardColumnTypeSchema.optional(),
  /** A split column has a Doing and a Done half. */
  isSplit: z.boolean().optional(),
  description: z.string().optional(),
});
export type AdoBoardColumn = z.infer<typeof adoBoardColumnSchema>;

export const adoBoardRowSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  color: z.string().nullable().optional(),
});
export type AdoBoardRow = z.infer<typeof adoBoardRowSchema>;

/**
 * The authoritative field names for this board. `columnField` is the
 * `WEF_<boardId>_Kanban.Column` field; `doneField` is the split-column
 * `...Kanban.Column.Done` boolean. Prefer these over building the key
 * from the board id when the board document is in hand.
 */
export const adoBoardFieldsSchema = z.object({
  columnField: adoFieldReferenceSchema,
  rowField: adoFieldReferenceSchema.optional(),
  doneField: adoFieldReferenceSchema.optional(),
});
export type AdoBoardFields = z.infer<typeof adoBoardFieldsSchema>;

export const adoBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  revision: z.number().int().optional(),
  isValid: z.boolean().optional(),
  canEdit: z.boolean().optional(),
  columns: z.array(adoBoardColumnSchema),
  rows: z.array(adoBoardRowSchema).optional(),
  fields: adoBoardFieldsSchema.optional(),
  allowedMappings: z.record(z.record(z.array(z.string()))).optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoBoard = z.infer<typeof adoBoardSchema>;

/* ------------------------------------------------------------------ */
/* GET .../work/taskboardcolumns                                       */
/* ------------------------------------------------------------------ */

export const adoTaskboardColumnMappingSchema = z.object({
  state: z.string(),
  workItemType: z.string(),
});
export type AdoTaskboardColumnMapping = z.infer<
  typeof adoTaskboardColumnMappingSchema
>;

export const adoTaskboardColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().nonnegative(),
  mappings: z.array(adoTaskboardColumnMappingSchema),
  _links: adoLinksSchema.optional(),
});
export type AdoTaskboardColumn = z.infer<typeof adoTaskboardColumnSchema>;

export const adoTaskboardColumnsSchema = z.object({
  columns: z.array(adoTaskboardColumnSchema),
  isCustomized: z.boolean().optional(),
  isValid: z.boolean().optional(),
  /** Spelt with three s's by the API itself. Kept verbatim. */
  validationMesssage: z.string().nullable().optional(),
});
export type AdoTaskboardColumns = z.infer<typeof adoTaskboardColumnsSchema>;

/* ------------------------------------------------------------------ */
/* GET .../iterations/{iterationId}/capacities                         */
/* GET .../iterations/{iterationId}/teamdaysoff                        */
/* ------------------------------------------------------------------ */

export const adoActivitySchema = z.object({
  capacityPerDay: z.number(),
  name: z.string().nullable(),
});
export type AdoActivity = z.infer<typeof adoActivitySchema>;

export const adoTeamMemberCapacitySchema = z.object({
  teamMember: adoIdentityRefSchema,
  activities: z.array(adoActivitySchema),
  daysOff: z.array(adoDateRangeSchema),
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoTeamMemberCapacity = z.infer<typeof adoTeamMemberCapacitySchema>;
/**
 * Capacities come back in one of two shapes, depending on which preview
 * of the API answers.
 *
 * `7.1-preview.2` uses the `{ count, value }` envelope every other list
 * endpoint uses. `7.1-preview.3` — the version we ask for — replaced it
 * with `{ teamMembers: [...] }` and no count. We shipped the envelope
 * schema against preview.3 and every board load failed with
 * `getTeamCapacities returned an unexpected shape`, which surfaced to the
 * user as a 502 with nothing to go on.
 *
 * Accepting both is not defensiveness for its own sake: the api-version
 * table above exists precisely because Microsoft promotes these without
 * warning, and this endpoint just proved it. Whichever arrives, the
 * normalised form is a plain array.
 */
export const adoCapacityListSchema = z.union([
  z.object({ teamMembers: z.array(adoTeamMemberCapacitySchema) }),
  adoListSchema(adoTeamMemberCapacitySchema),
]);
export type AdoCapacityList = z.infer<typeof adoCapacityListSchema>;

export const adoTeamSettingsDaysOffSchema = z.object({
  daysOff: z.array(adoDateRangeSchema),
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoTeamSettingsDaysOff = z.infer<
  typeof adoTeamSettingsDaysOffSchema
>;

/* ------------------------------------------------------------------ */
/* POST /_apis/wit/workitemsbatch  and  PATCH /_apis/wit/workitems/{id}*/
/* ------------------------------------------------------------------ */

/**
 * A work item's fields are an open record keyed by reference name. Read
 * them through the accessors below, never by casting.
 */
export const adoWorkItemFieldsSchema = z.record(z.unknown());
export type AdoWorkItemFields = z.infer<typeof adoWorkItemFieldsSchema>;

export const adoWorkItemSchema = z.object({
  id: z.number().int(),
  rev: z.number().int(),
  fields: adoWorkItemFieldsSchema,
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoWorkItem = z.infer<typeof adoWorkItemSchema>;
export const adoWorkItemListSchema = adoListSchema(adoWorkItemSchema);
export type AdoWorkItemList = z.infer<typeof adoWorkItemListSchema>;

/** Batch reads are capped at 200 ids per call by the service. */
export const ADO_WORK_ITEM_BATCH_LIMIT = 200;

export const adoWorkItemBatchRequestSchema = z.object({
  ids: z.array(z.number().int()).max(ADO_WORK_ITEM_BATCH_LIMIT),
  fields: z.array(z.string()).optional(),
  asOf: z.string().optional(),
  /** `omit` keeps one unreadable id from failing the whole batch. */
  errorPolicy: z.enum(['fail', 'omit']).optional(),
});
export type AdoWorkItemBatchRequest = z.infer<
  typeof adoWorkItemBatchRequestSchema
>;

export const adoJsonPatchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'remove', 'test', 'move', 'copy']),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});
export type AdoJsonPatchOperation = z.infer<typeof adoJsonPatchOperationSchema>;

export const adoJsonPatchDocumentSchema = z.array(adoJsonPatchOperationSchema);
export type AdoJsonPatchDocument = z.infer<typeof adoJsonPatchDocumentSchema>;

/** Content type the work item PATCH requires. */
export const ADO_JSON_PATCH_CONTENT_TYPE = 'application/json-patch+json';

/* ------------------------------------------------------------------ */
/* PATCH .../work/taskboardworkitems/{iterationId}/{workItemId}        */
/* ------------------------------------------------------------------ */

/**
 * Moves the taskboard card only. It does not change `System.State`, so a
 * move that must also transition state is two operations.
 */
export const adoTaskboardWorkItemUpdateSchema = z.object({
  newColumn: z.string(),
});
export type AdoTaskboardWorkItemUpdate = z.infer<
  typeof adoTaskboardWorkItemUpdateSchema
>;

export const adoTaskboardWorkItemColumnSchema = z.object({
  workItemId: z.number().int(),
  state: z.string().optional(),
  column: z.string().optional(),
  columnId: z.string().optional(),
});
export type AdoTaskboardWorkItemColumn = z.infer<
  typeof adoTaskboardWorkItemColumnSchema
>;

/* ------------------------------------------------------------------ */
/* POST /_apis/wit/wiql                                                */
/* Cross-project fallback, used only when a board has no iteration      */
/* subscription.                                                        */
/* ------------------------------------------------------------------ */

export const adoWiqlRequestSchema = z.object({
  query: z.string().min(1),
});
export type AdoWiqlRequest = z.infer<typeof adoWiqlRequestSchema>;

export const adoWiqlColumnSchema = z.object({
  referenceName: z.string(),
  name: z.string(),
  url: z.string().optional(),
});
export type AdoWiqlColumn = z.infer<typeof adoWiqlColumnSchema>;

export const adoWiqlResultSchema = z.object({
  queryType: z.string().optional(),
  queryResultType: z.string().optional(),
  asOf: z.string().optional(),
  columns: z.array(adoWiqlColumnSchema).optional(),
  /** Present for flat queries. */
  workItems: z.array(adoWorkItemReferenceSchema).optional(),
  /** Present for tree and one-hop queries. */
  workItemRelations: z.array(adoWorkItemLinkSchema).optional(),
});
export type AdoWiqlResult = z.infer<typeof adoWiqlResultSchema>;

/* ------------------------------------------------------------------ */
/* POST /_apis/hooks/subscriptions  and the workitem.updated payload   */
/* ------------------------------------------------------------------ */

export const adoSubscriptionRequestSchema = z.object({
  publisherId: z.string(),
  eventType: z.string(),
  resourceVersion: z.string().optional(),
  consumerId: z.string(),
  consumerActionId: z.string(),
  publisherInputs: z.record(z.string()),
  consumerInputs: z.record(z.string()),
});
export type AdoSubscriptionRequest = z.infer<
  typeof adoSubscriptionRequestSchema
>;

export const adoSubscriptionSchema = adoSubscriptionRequestSchema.extend({
  id: z.string(),
  status: z.string().optional(),
  url: z.string().optional(),
});
export type AdoSubscription = z.infer<typeof adoSubscriptionSchema>;

/** One changed field as the hook reports it. */
export const adoFieldUpdateSchema = z.object({
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});
export type AdoFieldUpdate = z.infer<typeof adoFieldUpdateSchema>;

export const adoWorkItemUpdatedResourceSchema = z.object({
  /** Update id, not the work item id. */
  id: z.number().int(),
  workItemId: z.number().int(),
  rev: z.number().int(),
  revisedBy: adoIdentityRefSchema.optional(),
  revisedDate: z.string().optional(),
  fields: z.record(adoFieldUpdateSchema).optional(),
  url: z.string().optional(),
  _links: adoLinksSchema.optional(),
});
export type AdoWorkItemUpdatedResource = z.infer<
  typeof adoWorkItemUpdatedResourceSchema
>;

export const adoResourceContainersSchema = z.object({
  collection: z.object({ id: z.string() }).optional(),
  account: z.object({ id: z.string() }).optional(),
  project: z.object({ id: z.string() }).optional(),
});
export type AdoResourceContainers = z.infer<typeof adoResourceContainersSchema>;

/** Body posted to our webhook endpoint by the service hook. */
export const adoWorkItemUpdatedEventSchema = z.object({
  id: z.string().optional(),
  eventType: z.literal('workitem.updated'),
  publisherId: z.string().optional(),
  resource: adoWorkItemUpdatedResourceSchema,
  resourceVersion: z.string().optional(),
  resourceContainers: adoResourceContainersSchema.optional(),
  createdDate: z.string().optional(),
});
export type AdoWorkItemUpdatedEvent = z.infer<
  typeof adoWorkItemUpdatedEventSchema
>;

/* ------------------------------------------------------------------ */
/* Errors and throttling                                               */
/* ------------------------------------------------------------------ */

/** The body Azure DevOps returns on any non-2xx. */
export const adoErrorResponseSchema = z.object({
  message: z.string().optional(),
  typeName: z.string().optional(),
  typeKey: z.string().optional(),
  errorCode: z.number().optional(),
  eventId: z.number().optional(),
  innerException: z.unknown().optional(),
});
export type AdoErrorResponse = z.infer<typeof adoErrorResponseSchema>;

/**
 * Throttling headers. The spec requires reading them on every response,
 * not only on a 429, so the sync worker can back off before the
 * interactive path is affected.
 */
export const ADO_RATE_LIMIT_HEADERS = {
  remaining: 'x-ratelimit-remaining',
  limit: 'x-ratelimit-limit',
  reset: 'x-ratelimit-reset',
  retryAfter: 'retry-after',
} as const;

export const adoRateLimitStateSchema = z.object({
  remaining: z.number().nullable(),
  limit: z.number().nullable(),
  /** Unix epoch seconds at which the window resets. */
  resetEpochSeconds: z.number().nullable(),
  retryAfterSeconds: z.number().nullable(),
  observedAt: z.string().datetime({ offset: true }),
});
export type AdoRateLimitState = z.infer<typeof adoRateLimitStateSchema>;

/** Header bag as undici and Node's http both expose it. */
export type AdoHeaderBag = Readonly<
  Record<string, string | string[] | undefined>
>;

const headerNumber = (bag: AdoHeaderBag, name: string): number | null => {
  const raw = bag[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Pure header read. Returns nulls rather than throwing on odd values. */
export function parseAdoRateLimitHeaders(
  headers: AdoHeaderBag,
  observedAt: Date,
): AdoRateLimitState {
  return {
    remaining: headerNumber(headers, ADO_RATE_LIMIT_HEADERS.remaining),
    limit: headerNumber(headers, ADO_RATE_LIMIT_HEADERS.limit),
    resetEpochSeconds: headerNumber(headers, ADO_RATE_LIMIT_HEADERS.reset),
    retryAfterSeconds: headerNumber(headers, ADO_RATE_LIMIT_HEADERS.retryAfter),
    observedAt: observedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Field reference names and the WEF board-column field                */
/* ------------------------------------------------------------------ */

/** Reference names the board reads from every work item. */
export const ADO_FIELDS = {
  id: 'System.Id',
  rev: 'System.Rev',
  title: 'System.Title',
  workItemType: 'System.WorkItemType',
  state: 'System.State',
  assignedTo: 'System.AssignedTo',
  areaPath: 'System.AreaPath',
  iterationPath: 'System.IterationPath',
  iterationId: 'System.IterationId',
  teamProject: 'System.TeamProject',
  tags: 'System.Tags',
  remainingWork: 'Microsoft.VSTS.Scheduling.RemainingWork',
} as const;

export type AdoWellKnownField = (typeof ADO_FIELDS)[keyof typeof ADO_FIELDS];

/** `System.Tags` is a single semicolon-separated string. */
export const ADO_TAG_SEPARATOR = '; ';

/**
 * The board id as it appears inside the WEF field name: braces and
 * dashes stripped, upper case. `4a1b...-...` becomes `4A1B...`.
 */
export function boardIdToFieldToken(boardId: string): string {
  return boardId.replace(/[{}-]/g, '').toUpperCase();
}

/** `WEF_<boardId>_Kanban.Column` — where a card's column actually lives. */
export function kanbanColumnFieldName(boardId: string): string {
  return `WEF_${boardIdToFieldToken(boardId)}_Kanban.Column`;
}

/** `WEF_<boardId>_Kanban.Column.Done` — the Done half of a split column. */
export function kanbanColumnDoneFieldName(boardId: string): string {
  return `WEF_${boardIdToFieldToken(boardId)}_Kanban.Column.Done`;
}

/** `WEF_<boardId>_Kanban.Lane` — swimlane on the native board. */
export function kanbanLaneFieldName(boardId: string): string {
  return `WEF_${boardIdToFieldToken(boardId)}_Kanban.Lane`;
}

/** JSON Patch path for a field reference name. */
export function fieldPath(referenceName: string): string {
  return `/fields/${referenceName}`;
}

/** Reads any string field, returning null rather than an empty string. */
export function readStringField(
  fields: AdoWorkItemFields,
  referenceName: string,
): string | null {
  const value = fields[referenceName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads any numeric field. Non-numbers and absent fields give null. */
export function readNumberField(
  fields: AdoWorkItemFields,
  referenceName: string,
): number | null {
  const value = fields[referenceName];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads a boolean field. Absent and non-boolean values give null. */
export function readBooleanField(
  fields: AdoWorkItemFields,
  referenceName: string,
): boolean | null {
  const value = fields[referenceName];
  return typeof value === 'boolean' ? value : null;
}

/** Reads an identity field such as `System.AssignedTo`. */
export function readIdentityField(
  fields: AdoWorkItemFields,
  referenceName: string,
): AdoIdentityRef | null {
  const parsed = adoIdentityRefSchema.safeParse(fields[referenceName]);
  return parsed.success ? parsed.data : null;
}

/** Splits `System.Tags` into trimmed, non-empty tags. */
export function readTagsField(fields: AdoWorkItemFields): string[] {
  const raw = readStringField(fields, ADO_FIELDS.tags);
  if (raw === null) return [];
  return raw
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** The board column a card sits in, for a given team board id. */
export function readKanbanColumn(
  fields: AdoWorkItemFields,
  boardId: string,
): string | null {
  return readStringField(fields, kanbanColumnFieldName(boardId));
}

/** The split-column Done flag for a given team board id. */
export function readKanbanColumnDone(
  fields: AdoWorkItemFields,
  boardId: string,
): boolean | null {
  return readBooleanField(fields, kanbanColumnDoneFieldName(boardId));
}
