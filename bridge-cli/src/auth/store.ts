import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CliError } from '../core/errors.js';

/**
 * Where the developer's session is kept between commands: the operating
 * system's keychain when there is one, else a file only its owner can read
 * (mode 0600, in a 0700 directory). One session per issuer.
 */
export interface StoredSession {
  readonly issuer: string;
  /** The app the issuer signs in to (the Bridge App). */
  readonly appId: string;
  readonly accessToken: string;
  /** When the access token expires, in ms since the epoch. */
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string | null;
  /** The workspace the tokens are for, when they are for one. */
  readonly workspace: string | null;
  readonly signedInAt: number;
}

export interface SessionStore {
  /** `keychain` or `file`, and where. */
  describe(): string;
  read(issuer: string): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  remove(issuer: string): Promise<void>;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with the given standard input. Secrets go on stdin, never in arguments. */
export type Runner = (command: string, args: readonly string[], input?: string) => Promise<RunResult>;

export const runProgram: Runner = (command, args, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });

function isSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s['issuer'] === 'string' && typeof s['appId'] === 'string' && typeof s['accessToken'] === 'string' && typeof s['accessTokenExpiresAt'] === 'number';
}

// ── File ─────────────────────────────────────────────────────────────────────

/** Sessions in `<dir>/sessions.json`, readable only by its owner. */
export class FileStore implements SessionStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'sessions.json');
  }

  describe(): string {
    return `file ${this.file}`;
  }

  private async all(): Promise<Record<string, StoredSession>> {
    let raw: string;
    try {
      const info = await stat(this.file);
      // Someone else could read it: take that away before using it.
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await chmod(this.file, 0o600);
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, StoredSession] => isSession(entry[1])));
    } catch {
      return {};
    }
  }

  private async save(all: Record<string, StoredSession>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    // The umask may have widened it; a session is for its owner only.
    if (process.platform !== 'win32') await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  async read(issuer: string): Promise<StoredSession | null> {
    return (await this.all())[issuer] ?? null;
  }

  async write(session: StoredSession): Promise<void> {
    const all = await this.all();
    all[session.issuer] = session;
    await this.save(all);
  }

  async remove(issuer: string): Promise<void> {
    const all = await this.all();
    if (!(issuer in all)) return;
    delete all[issuer];
    if (Object.keys(all).length === 0) {
      await unlink(this.file).catch(() => undefined);
      return;
    }
    await this.save(all);
  }
}

// ── Keychain ─────────────────────────────────────────────────────────────────

const SERVICE = 'bridge-cli';

/** The session as one base64 text, so it passes through a keychain tool with no quoting. */
function encode(session: StoredSession): string {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
}

function decode(text: string): StoredSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')) as unknown;
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The account name a session is kept under: the issuer, which a URL parser has already encoded. */
function account(issuer: string): string {
  if (/["'\\\s]/.test(issuer)) throw new CliError('misconfigured', 'The issuer has characters a keychain entry cannot be named with.');
  return issuer;
}

/** macOS: the login keychain, through `security`. */
export class MacKeychainStore implements SessionStore {
  constructor(private readonly run: Runner) {}

  describe(): string {
    return 'macOS keychain';
  }

  async read(issuer: string): Promise<StoredSession | null> {
    const found = await this.run('security', ['find-generic-password', '-s', SERVICE, '-a', account(issuer), '-w']);
    return found.code === 0 ? decode(found.stdout) : null;
  }

  async write(session: StoredSession): Promise<void> {
    // `security -i` reads the command from stdin, so the secret never shows in the process list.
    const line = `add-generic-password -U -s ${SERVICE} -a "${account(session.issuer)}" -l "Bridge CLI session" -w "${encode(session)}"\n`;
    const done = await this.run('security', ['-i'], line);
    if (done.code !== 0 || /error/i.test(done.stderr)) throw new Error(`The keychain refused the session: ${done.stderr.trim()}`);
  }

  async remove(issuer: string): Promise<void> {
    await this.run('security', ['delete-generic-password', '-s', SERVICE, '-a', account(issuer)]);
  }
}

/** Linux: the Secret Service (GNOME Keyring, KWallet), through `secret-tool`. */
export class SecretToolStore implements SessionStore {
  constructor(private readonly run: Runner) {}

  describe(): string {
    return 'Secret Service keyring';
  }

  async read(issuer: string): Promise<StoredSession | null> {
    const found = await this.run('secret-tool', ['lookup', 'service', SERVICE, 'account', account(issuer)]);
    return found.code === 0 ? decode(found.stdout) : null;
  }

  async write(session: StoredSession): Promise<void> {
    const done = await this.run('secret-tool', ['store', '--label=Bridge CLI session', 'service', SERVICE, 'account', account(session.issuer)], encode(session));
    if (done.code !== 0) throw new Error(`The keyring refused the session: ${done.stderr.trim()}`);
  }

  async remove(issuer: string): Promise<void> {
    await this.run('secret-tool', ['clear', 'service', SERVICE, 'account', account(issuer)]);
  }
}

/**
 * The keychain first, the file when the keychain cannot keep it. A session
 * is read from wherever it is, and removed from both.
 */
export class KeychainWithFileStore implements SessionStore {
  constructor(
    private readonly keychain: SessionStore,
    private readonly file: FileStore,
    private readonly warn: (message: string) => void,
  ) {}

  describe(): string {
    return this.keychain.describe();
  }

  async read(issuer: string): Promise<StoredSession | null> {
    return (await this.keychain.read(issuer)) ?? (await this.file.read(issuer));
  }

  async write(session: StoredSession): Promise<void> {
    try {
      await this.keychain.write(session);
    } catch (error) {
      this.warn(`${error instanceof Error ? error.message : String(error)} Keeping it in ${this.file.describe()} instead.`);
      await this.file.write(session);
      return;
    }
    await this.file.remove(session.issuer);
  }

  async remove(issuer: string): Promise<void> {
    await this.keychain.remove(issuer);
    await this.file.remove(issuer);
  }
}

function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  return (env['PATH'] ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, program)));
}

export interface StoreOptions {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly run?: Runner;
  readonly warn?: (message: string) => void;
}

/**
 * The store to use. `BRIDGE_TOKEN_STORE=file` forces the file (headless
 * machines, CI); `keychain` forces the keychain; by default the keychain is
 * used when this machine has one.
 */
export function chooseStore(options: StoreOptions): SessionStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProgram;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const file = new FileStore(options.dir);
  const wanted = (options.env['BRIDGE_TOKEN_STORE'] ?? 'auto').toLowerCase();
  if (wanted === 'file') return file;
  let keychain: SessionStore | null = null;
  if (platform === 'darwin' && (wanted === 'keychain' || existsSync('/usr/bin/security'))) keychain = new MacKeychainStore(run);
  if (platform === 'linux' && (wanted === 'keychain' || (onPath('secret-tool', options.env) && options.env['DBUS_SESSION_BUS_ADDRESS']))) {
    keychain = new SecretToolStore(run);
  }
  if (keychain === null) {
    if (wanted === 'keychain') throw new CliError('misconfigured', 'This machine has no keychain the CLI can use.', { hint: 'Unset BRIDGE_TOKEN_STORE, or set it to file.' });
    return file;
  }
  return new KeychainWithFileStore(keychain, file, warn);
}
