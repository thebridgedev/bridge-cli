/**
 * The CLI's operations as a library: every command is a plain function over
 * one client, so another front end (an MCP server, a script) can call the
 * same operations with the same pinned endpoints.
 */
export { BridgeClient } from './client.js';
export type { CallOptions, KeyCallOptions } from './client.js';
export { discover, readMetadata } from './core/discovery.js';
export type { Discovery } from './core/discovery.js';
export { CliError, isCliError } from './core/errors.js';
export type { CliErrorKind } from './core/errors.js';
export { API_VERSION, ROUTES, contractPath } from './core/routes.js';
export type { Route, RouteName } from './core/routes.js';
export { Sessions } from './auth/session.js';
export { chooseStore, FileStore } from './auth/store.js';
export type { SessionStore, StoredSession } from './auth/store.js';
export { signInWithBrowser, signInWithPassword } from './auth/sign-in.js';
export { apps } from './api/apps.js';
export { keys, withAppKey } from './api/keys.js';
export { plans, products, metrics, taxes, billingSettings, connection } from './api/billing.js';
export { flags, parseCondition } from './api/flags.js';
export { roles, privileges, workspaces, members, invites, appInvites } from './api/accounts.js';
export type { Invite, InviteFields } from './api/accounts.js';
export { buildProgram } from './program.js';
