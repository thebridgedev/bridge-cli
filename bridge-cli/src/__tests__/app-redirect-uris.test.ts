/**
 * TBP-546 — Unit tests for `bridge app redirect-uris list|add|remove`.
 *
 * Drives the commander actions end-to-end with a mocked management client and
 * the REAL output module (stdout/stderr captured via spies), so the JSON
 * envelope and exit codes are asserted exactly as a caller would see them.
 *
 * Covers:
 *  1. list  → { success: true, data: { redirectUris: [...] } }, [] when the
 *     app config has no redirectUris field.
 *  2. add   → update called with current list PLUS the new URL (existing
 *     entries preserved — the core regression these commands exist to
 *     prevent), reports added: true.
 *  3. add (duplicate) → no update call, added: false + message.
 *  4. add (invalid URL / non-http(s) scheme) → structured error on stderr,
 *     non-zero exit code, NO API calls at all.
 *  5. remove → update called with exactly that entry filtered out,
 *     reports removed: true.
 *  6. remove (absent) → error listing registered URIs, no update call.
 */

// Mock auth-core for the same reason as flag-init.test.ts — output.ts only
// needs HttpError, and the real package entry drags in the whole SDK graph.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
  { virtual: true },
);

// Stub config so no real credentials resolution happens. output.ts also
// imports ConfigError from this module, so the mock must provide it for the
// `instanceof ConfigError` check to stay valid.
jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerAppCommands } from '../commands/app.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

type MockClient = {
  app: { get: jest.Mock; update: jest.Mock };
};

/** Wire a fake management client whose app.get resolves to `appConfig`. */
function makeClient(appConfig: Record<string, unknown> = {}): MockClient {
  const client: MockClient = {
    app: {
      get: jest.fn().mockResolvedValue(appConfig),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  mockGetManagementClient.mockReturnValue(client);
  return client;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Run `bridge <args…>` through commander, capturing output + exit code. */
async function runCli(...args: string[]): Promise<CliResult> {
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
  registerAppCommands(program);

  try {
    await program.parseAsync(['node', 'bridge', ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return { stdout, stderr, exitCode };
}

function parseSuccess(res: CliResult): { success: boolean; data: any } {
  expect(res.stderr).toBe('');
  expect(res.exitCode).toBeUndefined();
  return JSON.parse(res.stdout);
}

function parseError(res: CliResult): { success: boolean; error: { code: string; message: string } } {
  expect(res.stdout).toBe('');
  return JSON.parse(res.stderr);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('bridge app redirect-uris list', () => {
  it('outputs the redirectUris from app.get', async () => {
    const uris = ['https://app.example.com/auth/oauth-callback', 'http://localhost:8080/cb'];
    const client = makeClient({ name: 'Acme', redirectUris: uris });

    const res = await runCli('app', 'redirect-uris', 'list');

    const out = parseSuccess(res);
    expect(out).toEqual({ success: true, data: { redirectUris: uris } });
    expect(client.app.get).toHaveBeenCalledTimes(1);
    expect(client.app.update).not.toHaveBeenCalled();
  });

  it('outputs an empty array when the app config has no redirectUris', async () => {
    makeClient({ name: 'Acme' });

    const res = await runCli('app', 'redirect-uris', 'list');

    expect(parseSuccess(res)).toEqual({ success: true, data: { redirectUris: [] } });
  });
});

describe('bridge app redirect-uris add', () => {
  it('appends a new URL while preserving every existing entry', async () => {
    const existing = [
      'https://app.example.com/auth/oauth-callback',
      'https://staging.example.com/auth/oauth-callback',
    ];
    const client = makeClient({ redirectUris: existing });
    const added = 'https://preview.example.com/auth/oauth-callback';

    const res = await runCli('app', 'redirect-uris', 'add', added);

    // Regression guard: the whole point of `add` is that it never replaces
    // the list wholesale — existing entries must survive.
    expect(client.app.update).toHaveBeenCalledTimes(1);
    expect(client.app.update).toHaveBeenCalledWith({
      redirectUris: [...existing, added],
    });
    const out = parseSuccess(res);
    expect(out.data.added).toBe(true);
    expect(out.data.redirectUris).toEqual([...existing, added]);
  });

  it('handles an app with no redirectUris field yet', async () => {
    const client = makeClient({});
    const added = 'https://app.example.com/auth/oauth-callback';

    const res = await runCli('app', 'redirect-uris', 'add', added);

    expect(client.app.update).toHaveBeenCalledWith({ redirectUris: [added] });
    expect(parseSuccess(res).data.added).toBe(true);
  });

  it('is a no-op when the URL is already registered', async () => {
    const existing = ['https://app.example.com/auth/oauth-callback'];
    const client = makeClient({ redirectUris: existing });

    const res = await runCli('app', 'redirect-uris', 'add', existing[0]);

    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseSuccess(res);
    expect(out.data.added).toBe(false);
    expect(out.data.message).toMatch(/Already registered/);
    expect(out.data.redirectUris).toEqual(existing);
  });

  it('rejects a relative/garbage URL without calling the API', async () => {
    const client = makeClient({ redirectUris: [] });

    const res = await runCli('app', 'redirect-uris', 'add', '/auth/callback');

    expect(client.app.get).not.toHaveBeenCalled();
    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseError(res);
    expect(out.success).toBe(false);
    expect(out.error.message).toMatch(/not an absolute URL/);
    expect(res.exitCode).toBe(1);
  });

  it('rejects a non-http(s) scheme without calling the API', async () => {
    const client = makeClient({ redirectUris: [] });

    const res = await runCli('app', 'redirect-uris', 'add', 'ftp://example.com/cb');

    expect(client.app.get).not.toHaveBeenCalled();
    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseError(res);
    expect(out.success).toBe(false);
    expect(out.error.message).toMatch(/must use http or https/);
    expect(res.exitCode).toBe(1);
  });
});

describe('bridge app redirect-uris remove', () => {
  it('removes exactly the named entry and keeps the rest', async () => {
    const existing = [
      'https://app.example.com/auth/oauth-callback',
      'https://staging.example.com/auth/oauth-callback',
      'http://localhost:8080/cb',
    ];
    const client = makeClient({ redirectUris: existing });

    const res = await runCli('app', 'redirect-uris', 'remove', existing[1]);

    expect(client.app.update).toHaveBeenCalledTimes(1);
    expect(client.app.update).toHaveBeenCalledWith({
      redirectUris: [existing[0], existing[2]],
    });
    const out = parseSuccess(res);
    expect(out.data.removed).toBe(true);
    expect(out.data.redirectUris).toEqual([existing[0], existing[2]]);
  });

  it('errors when the URL is not registered, listing the registered URIs', async () => {
    const existing = ['https://app.example.com/auth/oauth-callback'];
    const client = makeClient({ redirectUris: existing });

    const res = await runCli('app', 'redirect-uris', 'remove', 'https://gone.example.com/cb');

    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseError(res);
    expect(out.success).toBe(false);
    expect(out.error.message).toMatch(/not registered/);
    expect(out.error.message).toContain(existing[0]);
    expect(res.exitCode).toBe(1);
  });

  it('errors with "(none)" when nothing is registered at all', async () => {
    const client = makeClient({});

    const res = await runCli('app', 'redirect-uris', 'remove', 'https://gone.example.com/cb');

    expect(client.app.update).not.toHaveBeenCalled();
    expect(parseError(res).error.message).toMatch(/\(none\)/);
    expect(res.exitCode).toBe(1);
  });
});
