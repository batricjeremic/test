/**
 * Auth, permissions and security.
 *
 * Spec: "The board must never show a person a card they could not see in
 * Azure DevOps. Because reads run under a service identity, security
 * trimming is our responsibility, not the platform's."
 *
 * - `./token.js`   validates the hub's token and extracts the descriptor
 * - `./plugin.js`  attaches identity, trace id and ACL to the request
 * - `./acl.js`     resolves and caches that ACL for 15 minutes
 * - `./trim.js`    removes what the caller may not see, before it leaves
 * - `./identity.js` keeps the service and user identities apart
 */
export * from './identity.js';
export * from './token.js';
export * from './acl.js';
export * from './trim.js';
export * from './plugin.js';
