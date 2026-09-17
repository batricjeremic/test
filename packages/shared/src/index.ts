/**
 * DTOs shared verbatim by the hub and the BFF.
 *
 * Every type has a matching Zod schema: the BFF validates hub requests
 * and the hub validates BFF responses. Nothing here may import a
 * Node-only or server-only module — this package runs in the browser.
 */
export * from './primitives.js';
export * from './board.js';
export * from './iteration.js';
export * from './capacity.js';
export * from './filters.js';
export * from './move.js';
export * from './realtime.js';
export * from './audit.js';
export * from './api.js';
