/**
 * TBP-547 — `bridge auth methods list|enable|disable <method>`.
 *
 * The listing is the MCP tool get_auth_config's `loginMethods`, read from the
 * same app that `bridge auth config` and `bridge info auth-config` read, so
 * the three cannot disagree. Bridge itself refuses a social provider without
 * credentials and the last remaining sign-in method; those refusals come
 * through as the CLI's structured error with the server's fix as the hint.
 */

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  getManagementHttp: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { Command } from 'commander';
import { HttpError } from '@nebulr-group/bridge-auth-core';
import { getManagementClient } from '../config';
import { registerAuthCommands } from '../commands/auth.command';
import { registerInfoCommands } from '../commands/info.command';
import { resolveMethod } from '../commands/auth/methods.command';

const mockClient = getManagementClient as jest.Mock;

async function runCli(...args: string[]) {
  let stdout = '';
  let stderr = '';
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout += String(c); return true; });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr += String(c); return true; });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerAuthCommands(program);
  registerInfoCommands(program);
  try {
    await program.parseAsync(['node', 'bridge', ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return {
    exitCode,
    data: stdout ? JSON.parse(stdout).data : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}

const APP = {
  mfaEnabled: true,
  passkeysEnabled: false,
  magicLinkEnabled: true,
  googleSsoEnabled: true,
  linkedinSsoEnabled: false,
  azureAdSsoEnabled: false,
  appleSsoEnabled: false,
  githubSsoEnabled: true,
  facebookSsoEnabled: false,
  stripeEnabled: false,
  tenantSelfSignup: true,
  onboardingFlow: 'B2B',
  accessTokenTTL: 900,
  refreshTokenTTL: 86400,
};

function client(app = APP) {
  const c = {
    app: {
      get: jest.fn().mockResolvedValue(app),
      update: jest.fn().mockImplementation(async (patch: object) => ({ ...app, ...patch })),
      updateCredentials: jest.fn(),
    },
  };
  mockClient.mockReturnValue(c);
  return c;
}

beforeEach(() => jest.resetAllMocks());

describe('bridge auth methods list', () => {
  it('lists every login method exactly as get_auth_config does', async () => {
    client();
    const { data, exitCode } = await runCli('auth', 'methods', 'list');
    expect(exitCode).toBeUndefined();
    // The same object literal bridge-api's get_auth_config returns as loginMethods.
    expect(data).toEqual({
      loginMethods: {
        password: { enabled: true, note: 'Always available on Bridge' },
        magicLink: { enabled: true },
        passkeys: { enabled: false },
        mfa: { enabled: true, note: 'Second factor, not a standalone login method' },
        socialProviders: {
          google: { enabled: true },
          linkedin: { enabled: false },
          azureAd: { enabled: false },
          apple: { enabled: false },
          github: { enabled: true },
          facebook: { enabled: false },
        },
      },
    });
  });

  it('agrees with `bridge auth config` and `bridge info auth-config` on every switch', async () => {
    client();
    const list = (await runCli('auth', 'methods', 'list')).data.loginMethods;
    const flat = {
      magicLinkEnabled: list.magicLink.enabled,
      passkeysEnabled: list.passkeys.enabled,
      mfaEnabled: list.mfa.enabled,
      googleSsoEnabled: list.socialProviders.google.enabled,
      linkedinSsoEnabled: list.socialProviders.linkedin.enabled,
      azureAdSsoEnabled: list.socialProviders.azureAd.enabled,
      appleSsoEnabled: list.socialProviders.apple.enabled,
      githubSsoEnabled: list.socialProviders.github.enabled,
      facebookSsoEnabled: list.socialProviders.facebook.enabled,
    };
    for (const other of [['auth', 'config'], ['info', 'auth-config']]) {
      const { data } = await runCli(...other);
      expect(data).toMatchObject(flat);
    }
  });
});

describe('bridge auth methods enable|disable', () => {
  it('switches one app-level method and returns the new listing', async () => {
    const c = client();
    const { data } = await runCli('auth', 'methods', 'disable', 'magicLink');
    expect(c.app.update).toHaveBeenCalledWith({ magicLinkEnabled: false });
    expect(data.method).toBe('magicLink');
    expect(data.enabled).toBe(false);
    expect(data.loginMethods.magicLink).toEqual({ enabled: false });
  });

  it('switches a social provider off without touching its credentials', async () => {
    const c = client();
    const { data } = await runCli('auth', 'methods', 'disable', 'google');
    expect(c.app.update).toHaveBeenCalledTimes(1);
    expect(c.app.update).toHaveBeenCalledWith({ googleSsoEnabled: false });
    expect(c.app.updateCredentials).not.toHaveBeenCalled();
    expect(data.loginMethods.socialProviders.google).toEqual({ enabled: false });
  });

  it('switches a social provider back on with the flag alone', async () => {
    const c = client({ ...APP, githubSsoEnabled: false });
    const { data } = await runCli('auth', 'methods', 'enable', 'github');
    expect(c.app.update).toHaveBeenCalledWith({ githubSsoEnabled: true });
    expect(c.app.updateCredentials).not.toHaveBeenCalled();
    expect(data.enabled).toBe(true);
  });

  it.each([
    ['magic-link', 'magicLink', 'magicLinkEnabled'],
    ['AZUREAD', 'azureAd', 'azureAdSsoEnabled'],
    ['mfa', 'mfa', 'mfaEnabled'],
  ])('accepts %s as %s', (input, method, field) => {
    expect(resolveMethod(input)).toEqual({ method, field });
  });

  it('refuses an unknown method before calling Bridge, naming the valid ones', async () => {
    const c = client();
    const { error, exitCode } = await runCli('auth', 'methods', 'enable', 'twitter');
    expect(exitCode).toBe(1);
    expect(error.code).toBe('UNKNOWN_AUTH_METHOD');
    expect(error.hint).toContain('magicLink');
    expect(error.hint).toContain('facebook');
    expect(c.app.update).not.toHaveBeenCalled();
  });

  it('refuses to switch password, which has no switch on Bridge', async () => {
    const c = client();
    const { error, exitCode } = await runCli('auth', 'methods', 'disable', 'password');
    expect(exitCode).toBe(1);
    expect(error.code).toBe('PASSWORD_ALWAYS_ON');
    expect(c.app.update).not.toHaveBeenCalled();
  });

  it.each([
    ['enable', 'facebook', 'SIGN_IN_CREDENTIALS_MISSING',
      'Facebook sign-in was not switched on: this app has no Facebook credentials yet.',
      'Add the Facebook client id and secret first: … `bridge setup sso --provider facebook` …'],
    ['disable', 'magicLink', 'LAST_SIGN_IN_METHOD',
      'Nothing was changed: switching off magicLink would leave no way to sign in to this app.',
      'Switch another sign-in method on first (magic link, passkeys or a social provider), then switch this one off.'],
  ])('%s %s: Bridge\'s %s refusal comes through as code + hint', async (verb, method, code, message, fix) => {
    const c = client();
    c.app.update.mockRejectedValue(new HttpError(message, 400, { statusCode: 400, nblocksCode: code, message, fix }));
    const { error, exitCode } = await runCli('auth', 'methods', verb, method);
    expect(exitCode).toBe(1);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.hint).toBe(fix);
  });
});

describe('existing auth commands are unchanged (TBP-547 regression)', () => {
  it('`bridge auth mfa --enabled true` still sends only mfaEnabled', async () => {
    const c = client();
    await runCli('auth', 'mfa', '--enabled', 'true');
    expect(c.app.update).toHaveBeenCalledWith({ mfaEnabled: true });
  });

  it('`bridge auth config` keeps its flat shape', async () => {
    client();
    const { data } = await runCli('auth', 'config');
    expect(Object.keys(data).sort()).toEqual([
      'accessTokenTTL', 'azureAdSsoEnabled', 'appleSsoEnabled', 'facebookSsoEnabled', 'githubSsoEnabled',
      'googleSsoEnabled', 'linkedinSsoEnabled', 'magicLinkEnabled', 'mfaEnabled', 'onboardingFlow',
      'passkeysEnabled', 'refreshTokenTTL', 'tenantSelfSignup',
    ].sort());
  });
});
