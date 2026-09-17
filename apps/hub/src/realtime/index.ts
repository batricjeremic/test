/** WebSocket client, polling fallback and the visible degraded status. */
export {
  backoffDelay,
  createRealtimeClient,
  DEFAULT_ATTEMPTS_BEFORE_DEGRADED,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  resolveRealtimeUrl,
} from './client';
export type {
  RealtimeClient,
  RealtimeClientOptions,
  SequenceGap,
} from './client';
export type {
  RealtimeConnectionState,
  RealtimeMode,
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
  SubscribeFrame,
} from './types';
export { OFFLINE_REALTIME_STATE, useRealtime } from './useRealtime';
export type { UseRealtimeOptions } from './useRealtime';
