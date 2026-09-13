import { BridgeManagement } from '@nebulr-group/bridge-auth-core';
import {
  CredentialSelectorError,
  findCredential,
  isExpired,
  readCredentials,
  type StoredCredentials,
} from './credentials.js';

export const DEFAULT_BASE_URL = 'https://api.thebridge.dev';

let _client: BridgeManagement | null = null;

/**
 * The `--profile` value for this invocation, set by the CLI's preAction hook.
 *
 * A per-invocation override rather than a persisted switch, because that is
 * what scripts and long-running agent sessions need: target one app for one
 * command without mutating state another process is reading (TBP-628).
 */
let _profileOverride: string | null = null;

/** Called once from the CLI entrypoint, before any action runs. */
export function setProfileOverride(profile: string | null | undefined): void {
  _profileOverride = profile?.trim() || null;
}

/** The profile in force: `--profile` beats `BRIDGE_PROFILE`. */
function activeProfileSelector(): string | null {
  if (_profileOverride) return _profileOverride;
  return process.env.BRIDGE_PROFILE?.trim() || null;
}

/**
 * Resolution order:
 *   1. `--profile <label|id|name>` / `BRIDGE_PROFILE` — a stored credential,
 *      named for this one invocation. Never falls back: naming a profile and
 *      silently getting a different app is the exact failure TBP-628 exists to
 *      stop, so an unknown or expired profile is an error.
 *   2. The ACTIVE credential in `~/.config/bridge/credentials.json` (or
 *      `$XDG_CONFIG_HOME/...`), written by `bridge auth login` and moved by
 *      `bridge auth use`.
 *   3. `BRIDGE_API_KEY` env var (CI / service-account fallback). Used when no
 *      usable credentials file exists — the typical CI runner shape.
 *   4. Throw `ConfigError("Not logged in. Run `bridge auth login`.")`.
 *
 * The credentials file still wins over `BRIDGE_API_KEY`, unchanged, so
 * `bridge auth login` takes effect immediately and CI is unaffected. What HAS
 * changed is that being ignored is now said out loud: `BRIDGE_API_KEY` and
 * `BRIDGE_APP_ID` look like a way to retarget the CLI and are not, and reading
 * that in the output beats discovering it from a write that went to the wrong
 * app (TBP-628).
 *
 * Every resolution also prints one line to stderr naming the app that is about
 * to answer. See `writeContextBanner`.
 */
export function getManagementClient(): BridgeManagement {
  if (_client) return _client;

  const debug = process.env.BRIDGE_DEBUG === 'true';
  const envApiKey = process.env.BRIDGE_API_KEY?.trim();
  const envBaseUrl = process.env.BRIDGE_BASE_URL?.trim();

  let apiKey: string;
  let baseUrl: string;
  let source: string;
  let creds: StoredCredentials | null = null;

  const selector = activeProfileSelector();
  if (selector) {
    // 1. Explicit profile. Resolve it or fail — no fallback of any kind.
    let entry;
    try {
      entry = findCredential(selector);
    } catch (err) {
      if (err instanceof CredentialSelectorError) throw new ConfigError(err.message);
      throw err;
    }
    if (isExpired(entry.creds)) {
      throw new ConfigError(
        `Credential for "${selector}" (${entry.creds.app.name}) expired ` +
          `${entry.creds.expiresAt}. Run \`bridge auth login\` to re-authenticate it. ` +
          'Refusing to fall back to another app.',
      );
    }
    creds = entry.creds;
    apiKey = creds.apiKey;
    baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : creds.baseUrl;
    source = 'profile';
  } else {
    // 2. Active credential from `bridge auth login` / `bridge auth use`.
    const active = safeReadCredentials();
    if (active && !isExpired(active)) {
      creds = active;
      apiKey = active.apiKey;
      // Env override still wins for baseUrl (useful for hitting a local
      // bridge-api with a token issued by prod, or vice versa during dev).
      baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : active.baseUrl;
      source = 'credentials-file';
    } else if (envApiKey && envApiKey.length > 0) {
      // 3. BRIDGE_API_KEY env var (CI / service-account fallback).
      apiKey = envApiKey;
      baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : DEFAULT_BASE_URL;
      source = 'env';
    } else if (active && isExpired(active)) {
      // 4a. Found a credentials file but token expired; no env fallback either.
      throw new ConfigError(
        'Token expired. Run `bridge auth login` to re-authenticate.',
      );
    } else {
      // 4b. No credentials at all.
      throw new ConfigError('Not logged in. Run `bridge auth login`.');
    }
  }

  writeContextBanner({ creds, source, baseUrl, selector });

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
 * One line on stderr naming the app that is about to answer.
 *
 * On EVERY command, not only writes. The incident behind TBP-628 started with a
 * read: `bridge role list` was believed to describe the local app and described
 * production, and nothing in the output said otherwise. A banner that only
 * appears on writes would not have prevented it, because the wrong belief was
 * already formed by then.
 *
 * stderr, so stdout stays pure JSON for the agents and scripts that parse it.
 * Suppress with `BRIDGE_NO_BANNER=true` — for the one caller who is already
 * certain and is merging the two streams.
 */
function writeContextBanner(ctx: {
  creds: StoredCredentials | null;
  source: string;
  baseUrl: string;
  selector: string | null;
}): void {
  if (process.env.BRIDGE_NO_BANNER === 'true') return;

  const { creds, source, baseUrl, selector } = ctx;
  const who = creds
    ? `${creds.label ?? creds.app.name} (${creds.app.id})`
    : 'BRIDGE_API_KEY (app unknown — the key carries it)';
  const via =
    source === 'profile'
      ? `--profile ${selector}`
      : source === 'env'
        ? 'BRIDGE_API_KEY'
        : 'saved default';
  process.stderr.write(`bridge: ${who} · ${baseUrl} · via ${via}\n`);

  // The two env vars that look like a way to retarget the CLI and are not.
  // Saying so here, at the moment they are being ignored, is the whole point:
  // the reported incident was a session that set them and believed them.
  if (source !== 'env' && process.env.BRIDGE_API_KEY?.trim()) {
    process.stderr.write(
      'bridge: BRIDGE_API_KEY is set but IGNORED — the credentials file wins. ' +
        'Use `--profile <label>` to pick a stored app, or `bridge auth logout` to use the key.\n',
    );
  }
  if (process.env.BRIDGE_APP_ID?.trim()) {
    process.stderr.write(
      'bridge: BRIDGE_APP_ID has no effect — the app is carried by the credential itself. ' +
        'Use `--profile <label|app id>` or `BRIDGE_PROFILE` to target another app.\n',
    );
  }
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
