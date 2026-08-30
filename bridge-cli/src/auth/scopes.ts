/**
 * OAuth-style scopes the CLI can request at login (TBP-593).
 *
 * Deliberately a standalone, side-effect-free module: `login.command.ts` pulls
 * in config, credentials and the loopback server at import time, and importing
 * that from a test leaked state into unrelated suites.
 */

/** Default scope — read, list, create and update. No destructive authority. */
export const SCOPE_MANAGEMENT = 'management';

/**
 * Opt-in elevated scope, requested by `bridge auth login --admin`.
 *
 * Adds the destructive privileges plus `TOKEN_WRITE`, which is what
 * `bridge token create` requires. Without it a newly provisioned app can never
 * be given its own API key through the CLI.
 *
 * Not the default on purpose: this token is written to disk and lives for ten
 * days, and a credential like that should not carry delete authority unless
 * someone asked for it (TBP-552 made destructive privileges opt-in per token).
 */
export const SCOPE_MANAGEMENT_ADMIN = 'management:admin';

/**
 * Privileges the default scope does NOT grant and `--admin` does.
 *
 * Duplicated from the server rather than fetched so the CLI can still give an
 * actionable hint against an older bridge-api; a stale entry costs a slightly
 * wrong hint, not a broken command.
 */
export const ADMIN_SCOPE_PRIVILEGES = new Set([
  'TOKEN_WRITE',
  'TENANT_DELETE',
  'USER_DELETE',
  'ROLE_DELETE',
  'FLAG_DELETE',
  'APP_DELETE',
  'BRANDING_DELETE',
  'COMMUNICATION_DELETE',
]);
