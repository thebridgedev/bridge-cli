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
 * Reads and parses the credentials file. Returns `null` if the file does not
 * exist. Throws if the file exists but is unreadable or contains invalid JSON.
 */
export function readCredentials(): StoredCredentials | null {
  const filePath = credentialsPath();
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Credentials file at ${filePath} is not valid JSON.`);
  }

  if (!isStoredCredentials(parsed)) {
    throw new Error(`Credentials file at ${filePath} is missing required fields.`);
  }

  return parsed;
}

/**
 * Writes the credentials atomically with mode 0600. Creates the parent
 * directory with mode 0700 if it does not exist.
 */
export function writeCredentials(creds: StoredCredentials): void {
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
    fs.writeFileSync(fd, JSON.stringify(creds, null, 2) + '\n');
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
 * Deletes the credentials file. No-op if it does not exist.
 */
export function deleteCredentials(): void {
  const filePath = credentialsPath();
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
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
