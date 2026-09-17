/** The typed BFF client, its errors, and the fakes tests inject. */
export {
  createBoardApiClient,
  DEFAULT_MOVE_TIMEOUT_MS,
  resolveBffBaseUrl,
} from './client';
export type {
  BoardApiClient,
  BoardApiClientConfig,
  MoveRequestOptions,
} from './client';
export {
  BFF_BASE_URL_SETTING_KEY,
  parseBffBaseUrl,
  resolveBffEndpoint,
  saveBffBaseUrl,
} from './baseUrl';
export type { BffEndpoint, BffEndpointSource } from './baseUrl';
export {
  ApiClientError,
  describeApiError,
  isApiClientError,
  parseApiErrorBody,
} from './errors';
export type { ApiErrorKind, ApiClientErrorInit } from './errors';
export {
  CORRELATION_ID_HEADER,
  DEFAULT_TIMEOUT_MS,
  newTraceId,
  requestJson,
} from './http';
export type {
  HttpConfig,
  JsonRequest,
  JsonResponse,
  RequestOptions,
} from './http';
export {
  BOARD_QUERY_PARAM_KEYS,
  DEFAULT_BOARD_QUERY,
  decodeBoardQuery,
  encodeBoardQuery,
  mergeBoardQuery,
} from './query';
export type { BoardQuery } from './query';
export { toMoveFailure } from './moveFailures';
export type { MoveFailureContext } from './moveFailures';
export { ApiProvider, useApiClient, useOptionalApiClient } from './ApiProvider';
export type { ApiProviderProps } from './ApiProvider';
export { createFakeBoardApiClient } from './fakeClient';
export type {
  DeferredMove,
  FakeBoardApiClient,
  FakeBoardApiClientOptions,
  MoveHandler,
} from './fakeClient';
export {
  FIXTURE_BOARD_ID,
  FIXTURE_COLUMNS,
  FIXTURE_ORG_ID,
  FIXTURE_TIMESTAMP,
  makeBoardCard,
  makeBoardPermissions,
  makeBoardSnapshot,
  makeBoardTeamView,
  makeCanonicalColumn,
  makePersonLoad,
  makeRealtimeStatus,
  makeSwimlane,
  makeTeamIterationWindow,
  makeUnassignedSwimlane,
} from './fixtures';
