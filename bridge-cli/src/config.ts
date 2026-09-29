import { BridgeManagement, ManagementHttpClient } from '@nebulr-group/bridge-auth-core';
import {
  CredentialSelectorError,
  findCredential,
  isExpired,
  readCredentials,
  type StoredCredentials,
} from './credentials.js';
import {
  createWorkspaceClient,
  looksLikeAppId,
  resolveAppSelector,
} from './auth/workspace-client.js';

export const DEFAULT_BASE_URL = 'https://api.thebridge.dev';

let _client: BridgeManagement | null = null;
let _baseUrl: string | null = null;
let _apiKey: string | null = null;
let _http: ManagementHttpClient | null = null;

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
  const envBaseUrl = process.env.BRIDGE_BASE_URL?.trim();

  const selected = resolveSelectedCredential();
  const { creds, source, selector, baseUrl } = selected;
  // TBP-769 — a workspace login acting on another app swaps in that app's
  // short-lived token, fetched by `prepareAppContext()` before the action ran.
  const apiKey = _appContext ? _appContext.apiKey : selected.apiKey;

  writeContextBanner({ creds, source, baseUrl, selector, appContext: _appContext });

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
  _baseUrl = baseUrl;
  _apiKey = apiKey;

  return _client;
}

export interface SelectedCredential {
  /** Map key of the stored credential (its home app id); null for BRIDGE_API_KEY. */
  key: string | null;
  creds: StoredCredentials | null;
  /** The key to send: the login token, or BRIDGE_API_KEY. */
  apiKey: string;
  baseUrl: string;
  source: 'profile' | 'credentials-file' | 'env';
  selector: string | null;
}

/**
 * WHICH login is in force, per the resolution order documented on
 * `getManagementClient()`. Throws `ConfigError` exactly as it always has.
 * Offline; prints nothing.
 */
export function resolveSelectedCredential(): SelectedCredential {
  const envApiKey = process.env.BRIDGE_API_KEY?.trim();
  const envBaseUrl = process.env.BRIDGE_BASE_URL?.trim();
  const withBase = (fallback: string) =>
    envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : fallback;

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
    return {
      key: entry.key,
      creds: entry.creds,
      apiKey: entry.creds.apiKey,
      baseUrl: withBase(entry.creds.baseUrl),
      source: 'profile',
      selector,
    };
  }

  // 2. Active credential from `bridge auth login` / `bridge auth use`.
  const active = safeReadCredentials();
  if (active && !isExpired(active)) {
    // Env override still wins for baseUrl (useful for hitting a local
    // bridge-api with a token issued by prod, or vice versa during dev).
    return {
      key: active.app.id,
      creds: active,
      apiKey: active.apiKey,
      baseUrl: withBase(active.baseUrl),
      source: 'credentials-file',
      selector: null,
    };
  }
  if (envApiKey && envApiKey.length > 0) {
    // 3. BRIDGE_API_KEY env var (CI / service-account fallback).
    return {
      key: null,
      creds: null,
      apiKey: envApiKey,
      baseUrl: withBase(DEFAULT_BASE_URL),
      source: 'env',
      selector: null,
    };
  }
  if (active && isExpired(active)) {
    // 4a. Found a credentials file but token expired; no env fallback either.
    throw new ConfigError('Token expired. Run `bridge auth login` to re-authenticate.');
  }
  // 4b. No credentials at all.
  throw new ConfigError('Not logged in. Run `bridge auth login`.');
}

// ---------------------------------------------------------------------------
// TBP-769 — which app within the login: `--app` > `currentApp` > home.
// ---------------------------------------------------------------------------

/** The app a command acts on when it is not the login's home app. */
export interface AppContext {
  apiKey: string;
  app: { id: string; name: string };
  /** What picked it, for the stderr line: `--app X` or `current app`. */
  via: string;
}

let _appFlag: string | null = null;
let _appContext: AppContext | null = null;
/** Per-app tokens, in memory for this process only. Never written to disk. */
const _appTokenCache = new Map<string, { apiKey: string; app: { id: string; name: string }; expiresAt: number }>();

/** The global `--app` value for this invocation, set by the preAction hook. */
export function setAppOverride(app: string | null | undefined): void {
  _appFlag = app?.trim() || null;
}

/** The app the NEXT management client will act on, if not the home app. */
export function getAppContext(): AppContext | null {
  return _appContext;
}

function isHomeSelector(selector: string, home: { id: string; name: string }): boolean {
  return selector === home.id || selector.toLowerCase() === home.name.toLowerCase();
}

/**
 * Decide which app this command acts on and, for a workspace login targeting
 * a non-home app, fetch that app's short-lived token before the action runs
 * (`getManagementClient()` is synchronous, so this happens up front).
 *
 * Precedence: `--app` > the credential's `currentApp` (`bridge app use`) > home.
 * The home app needs no call: its token IS the login token, unchanged from
 * before TBP-769. Single-app logins and `BRIDGE_API_KEY` behave exactly as
 * before; asking them for another app is an error that says how to fix it.
 */
export async function prepareAppContext(fetchImpl?: typeof fetch): Promise<void> {
  _appContext = null;
  _client = null;
  _http = null;

  let selected: SelectedCredential;
  try {
    selected = resolveSelectedCredential();
  } catch (err) {
    // Without --app, leave "not logged in" etc. to the command, as before.
    if (!_appFlag) return;
    throw err;
  }

  if (selected.source === 'env' || !selected.creds || !selected.key) {
    if (_appFlag) {
      throw new ConfigError(
        '--app needs a workspace login from `bridge auth login`. ' +
          'BRIDGE_API_KEY is bound to the one app it was issued for.',
      );
    }
    return;
  }

  const creds = selected.creds;
  const target = _appFlag ?? creds.currentApp?.id ?? null;
  if (!target || isHomeSelector(target, creds.app)) return;

  if (creds.appAccess !== 'workspace') {
    // A stray currentApp on a single-app login cannot be honoured; ignore it
    // rather than fail every command. An explicit --app is a request: refuse.
    if (!_appFlag) return;
    throw Object.assign(
      new ConfigError(
        `This login covers only the app ${creds.app.name} (${creds.app.id}), so --app ${_appFlag} is not available.`,
      ),
      {
        hint:
          'Run `bridge auth login` again and choose "Every app in <workspace>" on the consent ' +
          'screen to work across apps with one login.',
      },
    );
  }

  const client = createWorkspaceClient({
    baseUrl: selected.baseUrl,
    loginToken: creds.apiKey,
    fetchImpl,
  });

  let targetId: string;
  if (looksLikeAppId(target)) {
    targetId = target;
  } else if (creds.currentApp && target.toLowerCase() === creds.currentApp.name.toLowerCase()) {
    targetId = creds.currentApp.id;
  } else {
    const { apps } = await client.listApps();
    targetId = resolveAppSelector(target, apps).id;
  }
  if (targetId === creds.app.id) return;

  const cacheKey = `${selected.key}:${targetId}`;
  const cached = _appTokenCache.get(cacheKey);
  let token: { apiKey: string; app: { id: string; name: string } };
  if (cached && cached.expiresAt - Date.now() > 15_000) {
    token = cached;
  } else {
    const res = await client.appToken(targetId);
    const exp = Date.parse(res.expiresAt);
    _appTokenCache.set(cacheKey, {
      apiKey: res.apiKey,
      app: res.app,
      expiresAt: Number.isNaN(exp) ? Date.now() + 60_000 : exp,
    });
    token = res;
  }

  _appContext = {
    apiKey: token.apiKey,
    app: token.app,
    via: _appFlag ? `--app ${_appFlag}` : 'current app (bridge app use)',
  };
}

/** For tests: forget --app, the chosen app and every cached per-app token. */
export function resetAppContext(): void {
  _appFlag = null;
  _appContext = null;
  _appTokenCache.clear();
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
  appContext: AppContext | null;
}): void {
  const { creds, source, baseUrl, selector, appContext } = ctx;

  // TBP-769 — acting on an app other than the login's home app is said out
  // loud even with BRIDGE_NO_BANNER: it is the one case where the credential
  // on disk does not name the app that is about to answer.
  if (appContext) {
    const home = creds ? `${creds.label ?? creds.app.name} (${creds.app.id})` : 'login';
    process.stderr.write(
      `bridge: Acting on app ${appContext.app.name} (${appContext.app.id}) · ${baseUrl} · ` +
        `via ${appContext.via}, workspace login ${home}\n`,
    );
    return;
  }

  if (process.env.BRIDGE_NO_BANNER === 'true') return;

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
        'Use `--profile <label>` to pick a stored login, `--app` to pick an app within it, ' +
        'or `bridge auth logout` to use the key.\n',
    );
  }
  if (process.env.BRIDGE_APP_ID?.trim()) {
    process.stderr.write(
      'bridge: BRIDGE_APP_ID has no effect — the app is carried by the credential itself. ' +
        'Use `--app <id|name>` (workspace login) or `--profile <label|app id>` to target another app.\n',
    );
  }
}

/**
 * The Bridge API base URL the management client talks to, resolved exactly as
 * `getManagementClient()` resolves it: `--profile`, then the active credential,
 * then `BRIDGE_API_KEY`, with `BRIDGE_BASE_URL` overriding each.
 *
 * Anything the CLI writes into a project (`bridge flag init`) takes its base
 * URL from here, so a project is wired to the environment the command just
 * read the app from. Re-reading the credentials file instead ignored
 * `--profile` and `BRIDGE_BASE_URL`, and wrote production into a project
 * scaffolded against stage (TBP-708).
 */
export function getResolvedBaseUrl(): string {
  getManagementClient();
  return _baseUrl as string;
}

/**
 * A raw authenticated HTTP client, resolved exactly as `getManagementClient()`
 * resolves (same `--profile`, credential, key and base URL, same banner).
 *
 * For routes auth-core has no typed service for yet — the integration checks
 * (TBP-541) — so the CLI can call them without waiting on an auth-core
 * release. The MCP tools use the same client type over the same routes.
 */
export function getManagementHttp(): ManagementHttpClient {
  if (_http) return _http;
  getManagementClient();
  const debug = process.env.BRIDGE_DEBUG === 'true';
  const quiet = () => undefined;
  const logger = {
    debug: debug ? (...a: unknown[]) => console.error('[bridge-cli]', ...a) : quiet,
    warn: debug ? (...a: unknown[]) => console.error('[bridge-cli]', ...a) : quiet,
    error: debug ? (...a: unknown[]) => console.error('[bridge-cli]', ...a) : quiet,
  };
  _http = new ManagementHttpClient(_baseUrl as string, _apiKey as string, logger);
  return _http;
}

/**
 * For tests and for `bridge auth logout` / `bridge auth status` — they need
 * to reset the cached client between operations.
 */
export function resetManagementClient(): void {
  _appContext = null;
  _client = null;
  _baseUrl = null;
  _apiKey = null;
  _http = null;
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
