/**
 * The Azure DevOps boundary: the `AdoClient` implementation, the shared
 * throttling budget it runs under, the retry policy from the spec's
 * failure table, and the JSON Patch builders for the write path.
 *
 * `./types.js` is re-exported too, so a consumer never has to know
 * whether a symbol is a raw REST shape or part of the client.
 */
export * from './types.js';
export * from './time.js';
export * from './rate-limit.js';
export * from './retry.js';
export * from './patch.js';
export * from './transport.js';
export * from './client.js';
