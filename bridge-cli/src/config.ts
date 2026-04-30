import { BridgeManagement } from '@nebulr-group/bridge-auth-core';
import { isExpired, readCredentials, type StoredCredentials } from './credentials.js';

export const DEFAULT_BASE_URL = 'https://api.thebridge.dev';

let _client: BridgeManagement | null = null;

/**
 * Resolution order:
 *   1. `~/.config/bridge/credentials.json` (or `$XDG_CONFIG_HOME/bridge/credentials.json`)
 *      written by `bridge auth login`. The interactive primary path. Token
 *      carries the appId baked in by /v1/auth/cli/token, so post-login the
 *      JWT is the source of truth for which app the CLI operates on.
 *   2. `BRIDGE_API_KEY` env var  (CI / service-account fallback). Used when no
 *      credentials file exists — typical CI runner shape.
 *   3. Throw `ConfigError("Not logged in. Run `bridge auth login`.")`.
 *
 * Note: credentials-file wins over env so `bridge auth login` does what users
 * expect — the new login takes effect immediately. CI is unaffected because
 * runners typically have no credentials file and fall through to step 2.
 *
 * If a credentials file exists but its `expiresAt` is in the past, we fall
 * through to env (if set) — same as if there were no file. Otherwise throw a
 * friendly error pointing the user back to `bridge auth login`.
 */
export function getManagementClient(): BridgeManagement {
  if (_client) return _client;

  const debug = process.env.BRIDGE_DEBUG === 'true';
  const envApiKey = process.env.BRIDGE_API_KEY?.trim();
  const envBaseUrl = process.env.BRIDGE_BASE_URL?.trim();

  let apiKey: string;
  let baseUrl: string;
  let source: string;

  // 1. Credentials file from `bridge auth login` (interactive primary).
  const creds = safeReadCredentials();
  if (creds && !isExpired(creds)) {
    apiKey = creds.apiKey;
    // Env override still wins for baseUrl (useful for hitting a local bridge-api
    // with a token issued by prod, or vice versa during dev).
    baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : creds.baseUrl;
    source = 'credentials-file';
  } else if (envApiKey && envApiKey.length > 0) {
    // 2. BRIDGE_API_KEY env var (CI / service-account fallback).
    apiKey = envApiKey;
    baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : DEFAULT_BASE_URL;
    source = 'env';
  } else if (creds && isExpired(creds)) {
    // 3a. Found a credentials file but token expired; no env fallback either.
    throw new ConfigError(
      'Token expired. Run `bridge auth login` to re-authenticate.',
    );
  } else {
    // 3b. No credentials at all.
    throw new ConfigError('Not logged in. Run `bridge auth login`.');
  }

  if (debug) {
    const baseSource =
      envBaseUrl && envBaseUrl.length > 0
        ? 'env'
        : source === 'env'
          ? 'default'
          : 'credentials-file';
    console.error(`[bridge-cli] apiKey=<redacted from ${source}> baseUrl=${baseUrl} (${baseSource})`);
  }

  _client = new BridgeManagement({ apiKey, baseUrl, debug });

  return _client;
}

/**
 * For tests and for `bridge auth logout` / `bridge auth status` — they need
 * to reset the cached client between operations.
 */
export function resetManagementClient(): void {
  _client = null;
}

export function resolveTenantId(opts: { tenantId?: string }): string {
  const tenantId = opts.tenantId || process.env.BRIDGE_TENANT_ID;
  if (!tenantId) {
    throw new ConfigError(
      'Tenant context required. Set BRIDGE_TENANT_ID environment variable or use --tenant-id flag.',
    );
  }
  return tenantId;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Wraps `readCredentials()` so a malformed file produces a `ConfigError` (caught
 * by `outputError`) rather than a raw `Error` stack trace. Returns `null` if
 * the file just doesn't exist (caller decides what to do).
 */
function safeReadCredentials(): StoredCredentials | null {
  try {
    return readCredentials();
  } catch (err) {
    throw new ConfigError(
      `Could not read credentials file: ${err instanceof Error ? err.message : String(err)}\n` +
        'Run `bridge auth login` to refresh, or delete the file manually.',
    );
  }
}
