/**
 * TBP-547 — Unit tests for `bridge auth methods list|enable|disable`.
 *
 * Same harness as app-redirect-uris.test.ts: commander actions driven
 * end-to-end with a mocked management client and the REAL output module
 * (stdout/stderr captured via spies).
 *
 * Covers:
 *  1. list  → { methods: [...] } aggregated shape: password always enabled
 *     with note, mixed toggle states from app.get, kinds, mfa factor note.
 *  2. enable → app.update called with exactly the matching boolean; social
 *     enables carry a setup-sso warning (azureAd maps to --provider azure,
 *     apple points at the dashboard), builtin enables don't.
 *  3. disable → app.update called with the boolean false; the ticket's
 *     zero-methods refusal is unreachable (password is always-on, verified —
 *     no disable switch exists in the platform), so the shipped guardrail is
 *     a note when a disable leaves password as the only login method.
 *  4. password + unknown methods on enable/disable → validation Error naming
 *     valid methods, no API calls.
 */

// Mock auth-core — output.ts only needs HttpError, and the real package entry
// drags in the whole SDK graph.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
  { virtual: true },
);

// Stub config so no real credentials resolution happens; output.ts imports
// ConfigError from this module.
jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerAuthMethodsCommands } from '../commands/auth/methods.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

type MockClient = {
  app: { get: jest.Mock; update: jest.Mock };
};

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

/** Run `bridge auth methods <args…>` through commander, capturing output. */
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
  program.exitOverride();
  const auth = program.command('auth');
  registerAuthMethodsCommands(auth);

  try {
    await program.parseAsync(['node', 'bridge', 'auth', 'methods', ...args]);
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

// App config with a realistic mix of states.
const MIXED_APP = {
  magicLinkEnabled: true,
  passkeysEnabled: false,
  mfaEnabled: true,
  googleSsoEnabled: true,
  azureAdSsoEnabled: false,
  appleSsoEnabled: false,
  githubSsoEnabled: true,
  facebookSsoEnabled: false,
  linkedinSsoEnabled: false,
};

describe('bridge auth methods list', () => {
  it('aggregates every method with enabled state, kind, and notes', async () => {
    const client = makeClient(MIXED_APP);

    const res = await runCli('list');

    const out = parseSuccess(res);
    expect(client.app.get).toHaveBeenCalledTimes(1);
    expect(client.app.update).not.toHaveBeenCalled();

    const methods: Array<{ method: string; enabled: boolean; kind: string; note?: string }> =
      out.data.methods;
    const byName = Object.fromEntries(methods.map((m) => [m.method, m]));

    // Full inventory — 10 methods, contract shape.
    expect(methods).toHaveLength(10);
    for (const m of methods) {
      expect(typeof m.method).toBe('string');
      expect(typeof m.enabled).toBe('boolean');
      expect(['builtin', 'social', 'factor']).toContain(m.kind);
    }

    // Password: always enabled, no disable switch — the note says so.
    expect(byName.password).toMatchObject({ enabled: true, kind: 'builtin' });
    expect(byName.password.note).toMatch(/[Aa]lways enabled/);
    expect(byName.password.note).toMatch(/no disable switch/);

    // Toggleable states reflect app.get.
    expect(byName.magicLink).toMatchObject({ enabled: true, kind: 'builtin' });
    expect(byName.passkeys).toMatchObject({ enabled: false, kind: 'builtin' });
    expect(byName.mfa).toMatchObject({ enabled: true, kind: 'factor' });
    expect(byName.mfa.note).toMatch(/[Ss]econd factor/);
    expect(byName.google).toMatchObject({ enabled: true, kind: 'social' });
    expect(byName.azureAd).toMatchObject({ enabled: false, kind: 'social' });
    expect(byName.apple).toMatchObject({ enabled: false, kind: 'social' });
    expect(byName.github).toMatchObject({ enabled: true, kind: 'social' });
    expect(byName.facebook).toMatchObject({ enabled: false, kind: 'social' });
    expect(byName.linkedin).toMatchObject({ enabled: false, kind: 'social' });
  });

  it('treats missing booleans as disabled', async () => {
    makeClient({});

    const res = await runCli('list');

    const methods: Array<{ method: string; enabled: boolean }> = parseSuccess(res).data.methods;
    for (const m of methods) {
      expect(m.enabled).toBe(m.method === 'password');
    }
  });
});

describe('bridge auth methods enable', () => {
  it('enables a builtin method with the matching field and no warning', async () => {
    const client = makeClient(MIXED_APP);

    const res = await runCli('enable', 'magicLink');

    expect(client.app.update).toHaveBeenCalledTimes(1);
    expect(client.app.update).toHaveBeenCalledWith({ magicLinkEnabled: true });
    const out = parseSuccess(res);
    expect(out.data).toMatchObject({ method: 'magicLink', enabled: true, kind: 'builtin' });
    expect(out.data.warning).toBeUndefined();
  });

  it.each([
    ['passkeys', 'passkeysEnabled'],
    ['mfa', 'mfaEnabled'],
    ['google', 'googleSsoEnabled'],
    ['azureAd', 'azureAdSsoEnabled'],
    ['apple', 'appleSsoEnabled'],
    ['github', 'githubSsoEnabled'],
    ['facebook', 'facebookSsoEnabled'],
    ['linkedin', 'linkedinSsoEnabled'],
  ])('maps %s to the %s field', async (method, field) => {
    const client = makeClient(MIXED_APP);

    const res = await runCli('enable', method);

    expect(client.app.update).toHaveBeenCalledWith({ [field]: true });
    expect(parseSuccess(res).data.enabled).toBe(true);
  });

  it('warns on social enable, pointing at bridge setup sso (credentials unknowable)', async () => {
    makeClient(MIXED_APP);

    const res = await runCli('enable', 'google');

    const out = parseSuccess(res);
    expect(out.data.warning).toMatch(/only flips the flag/);
    expect(out.data.warning).toContain('bridge setup sso --provider google');
  });

  it('maps azureAd warning to setup sso provider name "azure"', async () => {
    makeClient(MIXED_APP);

    const res = await runCli('enable', 'azureAd');

    expect(parseSuccess(res).data.warning).toContain('bridge setup sso --provider azure');
  });

  it('points apple at the dashboard (setup sso has no apple provider)', async () => {
    makeClient(MIXED_APP);

    const res = await runCli('enable', 'apple');

    const warning = parseSuccess(res).data.warning;
    expect(warning).toMatch(/dashboard/);
    expect(warning).not.toContain('--provider');
  });
});

describe('bridge auth methods disable', () => {
  it('disables with the matching field; no note while other login methods remain', async () => {
    const client = makeClient(MIXED_APP); // google + github still enabled

    const res = await runCli('disable', 'magicLink');

    expect(client.app.update).toHaveBeenCalledTimes(1);
    expect(client.app.update).toHaveBeenCalledWith({ magicLinkEnabled: false });
    const out = parseSuccess(res);
    expect(out.data).toMatchObject({ method: 'magicLink', enabled: false });
    expect(out.data.note).toBeUndefined();
  });

  it('guardrail: disabling the last toggleable login method succeeds (password is always-on) with a note', async () => {
    // The ticket's zero-methods refusal is unreachable — password has no
    // disable switch — so the shipped guardrail is this note.
    const client = makeClient({ ...MIXED_APP, googleSsoEnabled: false, githubSsoEnabled: false });

    const res = await runCli('disable', 'magicLink');

    expect(client.app.update).toHaveBeenCalledWith({ magicLinkEnabled: false });
    const out = parseSuccess(res);
    expect(out.data.enabled).toBe(false);
    expect(out.data.note).toMatch(/only enabled login method/);
    expect(out.data.note).toMatch(/cannot be disabled/);
  });

  it('disabling mfa (a factor) never carries the login-method note', async () => {
    const client = makeClient({ ...MIXED_APP, googleSsoEnabled: false, githubSsoEnabled: false, magicLinkEnabled: false });

    const res = await runCli('disable', 'mfa');

    expect(client.app.update).toHaveBeenCalledWith({ mfaEnabled: false });
    expect(parseSuccess(res).data.note).toBeUndefined();
  });
});

describe('validation errors', () => {
  it.each([['enable'], ['disable']])('%s password → error naming toggleable methods, no API calls', async (verb) => {
    const client = makeClient(MIXED_APP);

    const res = await runCli(verb, 'password');

    expect(client.app.get).not.toHaveBeenCalled();
    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseError(res);
    expect(out.success).toBe(false);
    expect(out.error.message).toMatch(/always enabled/);
    expect(out.error.message).toContain('magicLink');
    expect(out.error.message).toContain('linkedin');
    expect(res.exitCode).toBe(1);
  });

  it.each([['enable'], ['disable']])('%s unknown method → error listing valid names, no API calls', async (verb) => {
    const client = makeClient(MIXED_APP);

    const res = await runCli(verb, 'myspace');

    expect(client.app.get).not.toHaveBeenCalled();
    expect(client.app.update).not.toHaveBeenCalled();
    const out = parseError(res);
    expect(out.error.message).toContain('Unknown auth method: "myspace"');
    expect(out.error.message).toContain('magicLink');
    expect(out.error.message).toContain('passkeys');
    expect(out.error.message).toContain('mfa');
    expect(out.error.message).toContain('google');
    expect(res.exitCode).toBe(1);
  });
});
