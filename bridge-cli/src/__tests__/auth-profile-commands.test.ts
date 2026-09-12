/**
 * TBP-628 — the command surface for several apps: `auth use`, scoped `logout`,
 * and `auth status` listing everything.
 *
 * These drive the real commander commands end to end. The store-level and
 * resolution-level behaviour is covered in multi-app-credentials.test.ts; what
 * is asserted here is what a person actually sees and what the file looks like
 * afterwards.
 */
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({ __esModule: true, BridgeManagement: jest.fn() }),
);

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  credentialsPath,
  readCredentialsFile,
  writeCredentials,
  type StoredCredentials,
} from '../credentials';
import { registerAuthUseCommand } from '../commands/auth/use.command';
import { registerAuthLogoutCommand } from '../commands/auth/logout.command';
import { registerAuthStatusCommand } from '../commands/auth/status.command';

const ORIGINAL_ENV = process.env;
const HOUR = 60 * 60 * 1000;

function creds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    apiKey: 'jwt',
    expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: 'app-prod', name: 'NorthWhistle' },
    user: { id: 'u1', email: 'iman@nebulr.group' },
    baseUrl: 'https://api.thebridge.dev',
    ...overrides,
  };
}

const PROD = creds({ apiKey: 'jwt-prod', label: 'northwhistle-prod-ops' });
const LOCAL = creds({
  apiKey: 'jwt-local',
  app: { id: 'app-local', name: 'NorthWhistle Local' },
  label: 'northwhistle-local',
  baseUrl: 'http://localhost:3300',
});

type Run = { stdout: string; stderr: string; exitCode: number | undefined };

async function run(
  register: (auth: Command) => void,
  argv: string[],
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    stdout += String(c);
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
    stderr += String(c);
    return true;
  });
  const prev = process.exitCode;
  process.exitCode = undefined;

  const program = new Command();
  program.exitOverride();
  const auth = program.command('auth');
  register(auth);

  try {
    await program.parseAsync(['node', 'bridge', 'auth', ...argv]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prev;
  return { stdout, stderr, exitCode };
}

const use = (argv: string[]) => run(registerAuthUseCommand, ['use', ...argv]);
const logout = (argv: string[] = []) => run(registerAuthLogoutCommand, ['logout', ...argv]);
const status = () => run(registerAuthStatusCommand, ['status']);

let tmpHome: string;
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const k of ['BRIDGE_API_KEY', 'BRIDGE_APP_ID', 'BRIDGE_PROFILE', 'XDG_CONFIG_HOME']) {
    delete process.env[k];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-profile-cmd-'));
  process.env.HOME = tmpHome;
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env = ORIGINAL_ENV;
});

function seedBoth(): void {
  writeCredentials(PROD);
  writeCredentials(LOCAL); // leaves LOCAL active
}

// ---------------------------------------------------------------------------
// bridge auth use
// ---------------------------------------------------------------------------

describe('bridge auth use (TBP-628)', () => {
  it('switches by label with no network call at all', async () => {
    seedBoth();
    const { stdout, exitCode } = await use(['northwhistle-prod-ops']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Now using northwhistle-prod-ops');
    expect(readCredentialsFile()!.active).toBe('app-prod');
    // The entire point: no browser, no token exchange, no request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the baseUrl it switched to', async () => {
    seedBoth();
    const { stdout } = await use(['northwhistle-local']);
    expect(stdout).toContain('http://localhost:3300');
  });

  it('lists the other stored apps, so the next switch needs no lookup', async () => {
    seedBoth();
    const { stdout } = await use(['northwhistle-prod-ops']);
    expect(stdout).toContain('also stored: northwhistle-local');
  });

  it('fails, with the known profiles named, on an unknown one', async () => {
    seedBoth();
    const { stderr, exitCode } = await use(['staging']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No stored credential matches "staging"/);
    expect(stderr).toContain('northwhistle-prod-ops');
    // And it must not have moved the pointer on the way out.
    expect(readCredentialsFile()!.active).toBe('app-local');
  });

  it('allows switching to an expired credential but says so loudly', async () => {
    // Refusing would leave the user unable to make it the default before
    // re-authenticating it. Switching silently would surprise them one command
    // later, which is worse.
    writeCredentials(PROD);
    writeCredentials({ ...LOCAL, expiresAt: new Date(Date.now() - HOUR).toISOString() });
    await use(['northwhistle-prod-ops']);

    const { stdout, exitCode } = await use(['northwhistle-local']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/WARNING: this credential expired/);
    expect(readCredentialsFile()!.active).toBe('app-local');
  });
});

// ---------------------------------------------------------------------------
// bridge auth logout — now scoped
// ---------------------------------------------------------------------------

describe('bridge auth logout scope (TBP-628)', () => {
  it('removes only the active app and keeps the rest', async () => {
    seedBoth(); // LOCAL active
    const { stdout, exitCode } = await logout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('northwhistle-local');
    expect(stdout).toContain('1 credential(s) still stored');

    const file = readCredentialsFile()!;
    expect(Object.keys(file.credentials)).toEqual(['app-prod']);
    // Discarding a valid prod token because you finished with local is the
    // friction this ticket removes; it must not happen by default.
    expect(file.credentials['app-prod'].apiKey).toBe('jwt-prod');
    expect(file.active).toBe('app-prod');
  });

  it('--profile logs out of a named app, leaving the active one alone', async () => {
    seedBoth(); // LOCAL active
    const { stdout, exitCode } = await logout(['--profile', 'northwhistle-prod-ops']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('northwhistle-prod-ops');
    const file = readCredentialsFile()!;
    expect(Object.keys(file.credentials)).toEqual(['app-local']);
    expect(file.active).toBe('app-local');
  });

  it('--all removes everything and deletes the file', async () => {
    seedBoth();
    const { stdout, exitCode } = await logout(['--all']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Logged out of 2 app(s).');
    expect(fs.existsSync(credentialsPath())).toBe(false);
    // Both were revoked server-side, not just the active one.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('REGRESSION: single-app logout still deletes the file and says the email', async () => {
    writeCredentials(PROD);
    const { stdout, exitCode } = await logout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Logged out iman@nebulr.group');
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it('REGRESSION: no credentials at all still prints "Not logged in."', async () => {
    const { stdout, exitCode } = await logout();
    expect(stdout).toMatch(/Not logged in/);
    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bridge auth status — lists them all
// ---------------------------------------------------------------------------

describe('bridge auth status with several apps (TBP-628)', () => {
  it('lists every stored app and marks the active one', async () => {
    seedBoth(); // LOCAL active
    const { stdout } = await status();

    expect(stdout).toContain('app-prod');
    expect(stdout).toContain('app-local');
    // The active marker is what makes this answer the question people ask.
    expect(stdout).toMatch(/\* app=NorthWhistle Local/);
    expect(stdout).toMatch(/ {2}app=NorthWhistle \(/);
  });

  it('tells the reader how to switch, once there is more than one', async () => {
    seedBoth();
    const { stdout } = await status();
    expect(stdout).toContain('bridge auth use');
    expect(stdout).toContain('--profile');
  });

  it('does not offer switching advice for a single-app user', async () => {
    writeCredentials(PROD);
    const { stdout } = await status();
    expect(stdout).not.toContain('bridge auth use');
  });

  it('reports BRIDGE_PROFILE as overriding the active credential', async () => {
    seedBoth();
    process.env.BRIDGE_PROFILE = 'northwhistle-prod-ops';
    const { stdout } = await status();
    expect(stdout).toMatch(/BRIDGE_PROFILE=northwhistle-prod-ops is set/);
    expect(stdout).toMatch(/overrides the active credential/);
  });

  it('says BRIDGE_APP_ID has no effect', async () => {
    seedBoth();
    process.env.BRIDGE_APP_ID = 'app-local';
    const { stdout } = await status();
    expect(stdout).toMatch(/BRIDGE_APP_ID has no effect/);
  });
});

// ---------------------------------------------------------------------------
// The journey the ticket describes
// ---------------------------------------------------------------------------

describe('switch, work, switch back — with no browser step (TBP-628)', () => {
  it('round-trips between two apps and loses neither token', async () => {
    seedBoth(); // LOCAL active

    await use(['northwhistle-prod-ops']);
    expect(readCredentialsFile()!.active).toBe('app-prod');

    await use(['northwhistle-local']);
    expect(readCredentialsFile()!.active).toBe('app-local');

    const file = readCredentialsFile()!;
    expect(file.credentials['app-prod'].apiKey).toBe('jwt-prod');
    expect(file.credentials['app-local'].apiKey).toBe('jwt-local');
    // Not one network call in the whole round trip. Before TBP-628 this was two
    // browser logins.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
