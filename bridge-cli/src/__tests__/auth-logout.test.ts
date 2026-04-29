/**
 * TBP-113 — `bridge auth logout` integration test.
 *
 * Coverage:
 *  1. Credentials file present + revoke 200 → file deleted, "Logged out <email>".
 *  2. Credentials file present + revoke 401 → still treated as success.
 *  3. Credentials file missing → "Not logged in." exit 0, no fetch call.
 */
// `@nebulr-group/bridge-auth-core` is ESM-only; jest can't import it under the
// CJS transformer. Mock it virtually — the logout command path doesn't use it
// (it goes through `fetch` directly for `/v1/auth/cli/revoke`), but the
// `config.ts` module it imports does.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({ __esModule: true, BridgeManagement: jest.fn() }),
  { virtual: true },
);

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  credentialsPath,
  writeCredentials,
  type StoredCredentials,
} from '../credentials';
import { registerAuthLogoutCommand } from '../commands/auth/logout.command';

const ORIGINAL_ENV = process.env;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-logout-test-'));
}

function sampleCreds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    apiKey: 'fake-jwt-logout',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: 'a1', name: 'Acme' },
    user: { id: 'u1', email: 'bob@acme.com' },
    baseUrl: 'https://api.example.com',
    ...overrides,
  };
}

async function runLogout(): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
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
  const prev = process.exitCode;
  process.exitCode = undefined;

  const program = new Command();
  program.exitOverride();
  const auth = program.command('auth');
  registerAuthLogoutCommand(auth);

  try {
    await program.parseAsync(['node', 'bridge', 'auth', 'logout']);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prev;
  return { stdout, stderr, exitCode };
}

describe('bridge auth logout', () => {
  let tmpHome: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    tmpHome = freshTmpHome();
    process.env.HOME = tmpHome;
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
  });

  it('prints "Not logged in." and does not call fetch when no creds file', async () => {
    const { stdout, exitCode } = await runLogout();
    expect(stdout).toMatch(/Not logged in/);
    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('revokes server-side and deletes the credentials file on 200', async () => {
    writeCredentials(sampleCreds());
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { stdout, exitCode } = await runLogout();

    expect(stdout).toContain('Logged out bob@acme.com');
    expect(exitCode).toBe(0);
    expect(fs.existsSync(credentialsPath())).toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/auth/cli/revoke');
    expect((opts as RequestInit).method).toBe('POST');
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('fake-jwt-logout');
  });

  it('treats 401 from revoke as success (token already gone) and still deletes the file', async () => {
    writeCredentials(sampleCreds());
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { stdout, exitCode } = await runLogout();

    expect(stdout).toContain('Logged out bob@acme.com');
    expect(exitCode).toBe(0);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it('still deletes the local file when the server returns a generic error', async () => {
    writeCredentials(sampleCreds());
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'server_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { stdout, stderr, exitCode } = await runLogout();

    expect(stderr).toMatch(/Warning/);
    expect(stdout).toContain('Logged out bob@acme.com');
    expect(exitCode).toBe(0);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });
});
