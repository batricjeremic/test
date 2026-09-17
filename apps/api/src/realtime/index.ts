/**
 * The realtime boundary: the hub that owns the board channels, the
 * service hook endpoint that feeds it, and the degraded-mode status the
 * snapshot carries so "live updates off" is visible rather than silent.
 */
export * from './socket.js';
export * from './hub.js';
export * from './status.js';
export * from './verify.js';
export * from './webhook.js';
export * from './routes.js';
