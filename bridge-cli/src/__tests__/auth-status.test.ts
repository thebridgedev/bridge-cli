/**
 * TBP-113 — `bridge auth status` integration test.
 *
 * Drives `registerAuthStatusCommand` end-to-end against the real credentials
 * file (in a temp HOME dir). Captures stdout to assert the printed lines.
 *
 * Coverage:
 *  1. No file + no env → "Not logged in. Run `bridge auth login`."
 *  2. Valid creds → "Logged in as <email>" + relative-time line.
 *  3. Expired creds → "(EXPIRED)" suffix.
 *  4. BRIDGE_API_KEY env set + no file → service-account note.
 */
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeCredentials, type StoredCredentials } from '../credentials';
import { registerAuthStatusCommand } from '../commands/auth/status.command';

const ORIGINAL_ENV = process.env;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-status-test-'));
}

function sampleCreds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    apiKey: 'fake-jwt-status',
    expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: 'app-1', name: 'Acme App' },
    user: { id: 'user-1', email: 'alice@acme.com' },
    baseUrl: 'https://api.thebridge.dev',
    ...overrides,
  };
}

async function runStatus(): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += String(chunk);
    return true;
  });
  const prevExit = process.exitCode;
  process.exitCode = undefined;

  const program = new Command();
  // Keep commander from `process.exit`-ing the test runner on parse errors.
  program.exitOverride();
  const auth = program.command('auth');
  registerAuthStatusCommand(auth);

  try {
    await program.parseAsync(['node', 'bridge', 'auth', 'status']);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return { stdout, stderr, exitCode };
}

describe('bridge auth status', () => {
  let tmpHome: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    tmpHome = freshTmpHome();
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
  });

  it('prints "Not logged in" when no creds file and no env var', async () => {
    const { stdout, exitCode } = await runStatus();
    expect(stdout).toMatch(/Not logged in\. Run `bridge auth login`/);
    expect(exitCode).toBe(0);
  });

  it('prints email + app + relative expiry when logged in', async () => {
    writeCredentials(sampleCreds());
    const { stdout, exitCode } = await runStatus();
    expect(stdout).toContain('Logged in as alice@acme.com');
    expect(stdout).toContain('app=Acme App (app-1)');
    expect(stdout).toMatch(/expires=in \d+ days?/);
    expect(stdout).toContain('baseUrl=https://api.thebridge.dev');
    expect(exitCode).toBe(0);
  });

  it('marks expired credentials with (EXPIRED)', async () => {
    writeCredentials(sampleCreds({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    const { stdout } = await runStatus();
    expect(stdout).toContain('(EXPIRED)');
  });

  it('prints the service-account note when BRIDGE_API_KEY is set but no file', async () => {
    process.env.BRIDGE_API_KEY = 'env-fake-key';
    const { stdout } = await runStatus();
    expect(stdout).toMatch(/Using BRIDGE_API_KEY from environment/);
    expect(stdout).toMatch(/service-account/);
  });

  it('warns when BRIDGE_API_KEY is also set alongside a creds file', async () => {
    writeCredentials(sampleCreds());
    process.env.BRIDGE_API_KEY = 'env-fake-key';
    const { stdout } = await runStatus();
    expect(stdout).toContain('Logged in as alice@acme.com');
    expect(stdout).toMatch(/BRIDGE_API_KEY is also set/);
  });
});
