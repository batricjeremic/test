/**
 * The domain: pure aggregation the whole product rests on.
 *
 * Nothing in here does I/O. Raw Azure DevOps shapes and configuration
 * rows go in, `@eg/shared` DTOs come out, and a `Clock` is injected
 * wherever time matters, so every rule the spec states is exhaustively
 * testable without Redis, Postgres or Azure DevOps.
 */
export * from './sorting.js';
export * from './working-days.js';
export * from './area-paths.js';
export * from './mapping.js';
export * from './cards.js';
export * from './iteration.js';
export * from './capacity.js';
export * from './filters.js';
export * from './swimlanes.js';
export * from './snapshot.js';
