/**
 * Credentials file management for bridge-cli.
 *
 * Stores the long-lived CLI JWT obtained via `bridge auth login` so subsequent
 * commands can authenticate without `BRIDGE_API_KEY`. The token is sent to
 * bridge-api as `x-api-key: <jwt>` (same path as `BRIDGE_API_KEY`).
 *
 * Path resolution (XDG-compliant, RFC 8252-friendly):
 *   1. `$XDG_CONFIG_HOME/bridge/credentials.json` if env is set
 *   2. `~/.config/bridge/credentials.json` otherwise
 *
 * File mode: 0600 (owner read/write only). Containing dir created with 0700.
 *
 * ## The file holds MANY apps (TBP-628)
 *
 * It used to hold exactly one. Anyone running the same product as several apps
 * — one appId per environment — had to `logout` + `login` through the browser
 * to move between them, even though the token they already held had days left
 * on it. Worse, nothing in a read command's output said which app answered, so
 * a session holding a prod token could run `role list` believing it described
 * local, and the next step would have rewritten production roles.
 *
 * So the on-disk shape is now a map keyed by app id, plus a pointer at the
 * active one:
 *
 * ```json
 * {
 *   "version": 2,
 *   "active": "606b4416fabdc800087d09ec",
 *   "credentials": { "606b4416fabdc800087d09ec": { …StoredCredentials } }
 * }
 * ```
 *
 * Keyed by app id, not by label: the label is optional and user-chosen, so it
 * is a fine way to SELECT a credential and a bad way to key one.
 *
 * A v1 file (a bare `StoredCredentials` object) is migrated on read, in memory
 * only. Reading never rewrites the file — a read command must not mutate state
 * another process is reading. The v2 shape is persisted the next time
 * something writes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface StoredCredentials {
  /** The JWT to send as `x-api-key`. Same shape as `BRIDGE_API_KEY`. */
  apiKey: string;
  /** ISO 8601 timestamp at which `apiKey` becomes invalid. */
  expiresAt: string;
  /** ISO 8601 timestamp the token was issued (for diagnostics). */
  issuedAt: string;
  /** App the token is scoped to. */
  app: { id: string; name: string };
  /** User who authorized the token. */
  user: { id: string; email: string };
  /** Base URL of the bridge-api this token is valid against. */
  baseUrl: string;
  /** Optional human-friendly label set via `bridge auth login --label`. */
  label?: string;
}

/** Current on-disk shape. See the module docstring for why it is a map. */
export interface CredentialsFile {
  version: 2;
  /** App id of the credential commands use by default. `null` when empty. */
  active: string | null;
  /** All stored credentials, keyed by `app.id`. */
  credentials: Record<string, StoredCredentials>;
}

/** One entry, as `bridge auth status` and the selector logic see it. */
export interface CredentialEntry {
  /** The map key — always `creds.app.id`. */
  key: string;
  creds: StoredCredentials;
  isActive: boolean;
}

/**
 * Returns the absolute path to the credentials file based on the current
 * environment. Does not create directories or files — pure path resolution.
 *
 * Resolution (per XDG Base Directory spec):
 *   1. `$XDG_CONFIG_HOME/bridge/credentials.json` if XDG_CONFIG_HOME is set.
 *   2. `$HOME/.config/bridge/credentials.json` otherwise.
 *   3. `os.homedir()/.config/bridge/credentials.json` if HOME is unset
 *      (Windows / corner cases).
 *
 * We deliberately prefer `process.env.HOME` over `os.homedir()` because (a)
 * the XDG spec is defined in terms of `$HOME`, and (b) Node's `os.homedir()`
 * on some test runners (jest) bypasses the `HOME` env var via libuv, which
 * makes overriding it for tests impossible without a wrapper like this.
 */
export function credentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'bridge', 'credentials.json');
  }
  const home = process.env.HOME?.trim();
  const base = home && home.length > 0 ? home : os.homedir();
  return path.join(base, '.config', 'bridge', 'credentials.json');
}

/**
 * Read the whole store, migrating a v1 file in memory. `null` if no file.
 *
 * Throws if the file exists but is unreadable or malformed — a corrupt store is
 * not the same as an absent one, and silently treating it as absent would make
 * `bridge auth status` report "not logged in" to somebody who very much is.
 */
export function readCredentialsFile(): CredentialsFile | null {
  const filePath = credentialsPath();
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Credentials file at ${filePath} is not valid JSON.`);
  }

  // v2 — the current shape.
  if (isCredentialsFile(parsed)) return parsed;

  // v1 — a bare StoredCredentials object. Migrate in memory; do NOT write.
  if (isStoredCredentials(parsed)) {
    return {
      version: 2,
      active: parsed.app.id,
      credentials: { [parsed.app.id]: parsed },
    };
  }

  throw new Error(`Credentials file at ${filePath} is missing required fields.`);
}

/**
 * The credential commands act on by default: the active one.
 *
 * Kept with its original name and signature because every existing caller wants
 * exactly this, and because "which credential is in force" is a question with
 * one answer whether the file holds one app or ten.
 */
export function readCredentials(): StoredCredentials | null {
  const file = readCredentialsFile();
  if (!file) return null;
  if (file.active && file.credentials[file.active]) return file.credentials[file.active];
  // A pointer at a credential that is gone. Fall back to the only entry if
  // there is exactly one — otherwise there is no defensible default, and
  // guessing would pick an app on the user's behalf, which is the failure this
  // ticket exists to stop.
  const keys = Object.keys(file.credentials);
  return keys.length === 1 ? file.credentials[keys[0]] : null;
}

/** Every stored credential, active one first, then by app name. */
export function listCredentials(): CredentialEntry[] {
  const file = readCredentialsFile();
  if (!file) return [];
  return Object.entries(file.credentials)
    .map(([key, creds]) => ({ key, creds, isActive: key === file.active }))
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.creds.app.name.localeCompare(b.creds.app.name);
    });
}

/** Raised when a selector matches nothing, or matches more than one entry. */
export class CredentialSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialSelectorError';
  }
}

/**
 * Find one stored credential by label, app id, or app name.
 *
 * Label first: users think in environments, not in 24-character object ids, and
 * `--label` exists precisely so they can name one. App id is exact and always
 * works. App name is last because two apps may share one.
 *
 * An ambiguous selector is an ERROR, never a first match. Picking one of two
 * candidate apps silently is the whole failure mode this ticket is about.
 */
export function findCredential(selector: string): CredentialEntry {
  const needle = selector.trim();
  if (!needle) throw new CredentialSelectorError('Empty profile selector.');

  const entries = listCredentials();
  if (entries.length === 0) {
    throw new CredentialSelectorError(
      'No stored credentials. Run `bridge auth login` first.',
    );
  }

  const lower = needle.toLowerCase();
  const byLabel = entries.filter((e) => e.creds.label?.toLowerCase() === lower);
  const byId = entries.filter((e) => e.key === needle);
  const byName = entries.filter((e) => e.creds.app.name.toLowerCase() === lower);

  for (const [what, matches] of [
    ['label', byLabel],
    ['app id', byId],
    ['app name', byName],
  ] as const) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new CredentialSelectorError(
        `"${needle}" matches ${matches.length} stored credentials by ${what} ` +
          `(${matches.map((m) => m.key).join(', ')}). Select by app id instead.`,
      );
    }
  }

  throw new CredentialSelectorError(
    `No stored credential matches "${needle}". Known: ` +
      entries.map((e) => e.creds.label ?? e.creds.app.name).join(', ') +
      '. Run `bridge auth status` to see them all.',
  );
}

/**
 * Upsert a credential by app id and make it active.
 *
 * Same name and signature as before: `bridge auth login` still ends with one
 * call, and still leaves the app it just authorised in force.
 */
export function writeCredentials(creds: StoredCredentials): void {
  const file = readCredentialsFileOrEmpty();
  file.credentials[creds.app.id] = creds;
  file.active = creds.app.id;
  writeCredentialsFile(file);
}

/** Point the persisted default at an already-stored credential. Offline. */
export function setActiveCredential(key: string): void {
  const file = readCredentialsFileOrEmpty();
  if (!file.credentials[key]) {
    throw new CredentialSelectorError(`No stored credential with app id ${key}.`);
  }
  file.active = key;
  writeCredentialsFile(file);
}

/** Persist the store atomically with mode 0600, dir 0700. */
export function writeCredentialsFile(file: CredentialsFile): void {
  const filePath = credentialsPath();
  const dir = path.dirname(filePath);

  // Create dir with restrictive perms. mkdirSync `mode` is masked by umask, so
  // we explicitly chmod after to guarantee 0700 regardless of inherited umask.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // chmod fails on Windows for non-NTFS fs — non-fatal there.
  }

  // Write to a tmp file then rename for atomicity. Open with mode 0600 from
  // the start so the JWT is never world-readable, even briefly.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(file, null, 2) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort; openSync's mode arg already set perms.
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Remove ONE credential. Deletes the file entirely when it was the last.
 *
 * Returns the remaining count so a caller can tell the user what is left.
 * Removing the active one moves `active` to another entry rather than leaving a
 * dangling pointer — with credentials still stored, "logged out of everything"
 * would be a lie.
 */
export function removeCredential(key: string): number {
  const file = readCredentialsFileOrEmpty();
  delete file.credentials[key];
  const remaining = Object.keys(file.credentials);
  if (remaining.length === 0) {
    deleteAllCredentials();
    return 0;
  }
  if (file.active === key) file.active = remaining[0];
  writeCredentialsFile(file);
  return remaining.length;
}

/** Delete the whole credentials file. No-op if it does not exist. */
export function deleteAllCredentials(): void {
  const filePath = credentialsPath();
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Back-compat alias for the single-app era: remove the active credential.
 *
 * @deprecated Prefer `removeCredential(key)` or `deleteAllCredentials()`, which
 * say which of the two things they do.
 */
export function deleteCredentials(): void {
  const file = readCredentialsFileOrEmpty();
  if (file.active) {
    removeCredential(file.active);
    return;
  }
  deleteAllCredentials();
}

/** The store, or an empty one — for the write paths, which create on demand. */
function readCredentialsFileOrEmpty(): CredentialsFile {
  try {
    return readCredentialsFile() ?? { version: 2, active: null, credentials: {} };
  } catch {
    // A corrupt file must not wedge `login` — overwriting it is how the user
    // gets unstuck, and the token in it is unusable anyway.
    return { version: 2, active: null, credentials: {} };
  }
}

function isCredentialsFile(value: unknown): value is CredentialsFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 2) return false;
  if (v.active !== null && typeof v.active !== 'string') return false;
  if (!v.credentials || typeof v.credentials !== 'object') return false;
  return Object.values(v.credentials as Record<string, unknown>).every(isStoredCredentials);
}

/**
 * True if the credentials' `expiresAt` is in the past relative to `now`.
 */
export function isExpired(creds: StoredCredentials, now: Date = new Date()): boolean {
  const expiry = Date.parse(creds.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry <= now.getTime();
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiKey === 'string' &&
    typeof v.expiresAt === 'string' &&
    typeof v.issuedAt === 'string' &&
    typeof v.baseUrl === 'string' &&
    typeof v.app === 'object' &&
    v.app !== null &&
    typeof (v.app as Record<string, unknown>).id === 'string' &&
    typeof (v.app as Record<string, unknown>).name === 'string' &&
    typeof v.user === 'object' &&
    v.user !== null &&
    typeof (v.user as Record<string, unknown>).id === 'string' &&
    typeof (v.user as Record<string, unknown>).email === 'string'
  );
}
