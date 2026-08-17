/**
 * TBP-539 — Unit tests for the read-tool batch, one happy path + one error
 * mapping per tool, against a mocked BridgeManagement client.
 *
 * Error mapping: handlers duck-type auth-core's HttpError (an Error carrying a
 * numeric `status` and optional `body`) instead of instanceof-checking, because
 * the transport shell constructs the client from its own copy of auth-core.
 */
import {
  bridgeTools,
  listFeatureFlagsTool,
  listPlansTool,
  listRolesTool,
  getAuthConfigTool,
  getEnvironmentInfoTool,
} from '../index.js';
import type { ToolContext } from '../index.js';

const APP = {
  id: 'app_123',
  name: 'Test App',
  apiUrl: 'https://api.example.com',
  uiUrl: 'https://app.example.com',
  websiteUrl: 'https://example.com',
  redirectUris: ['https://app.example.com/auth/oauth-callback'],
  allowedOrigins: ['https://app.example.com'],
  defaultCallbackUri: 'https://app.example.com/auth/oauth-callback',
  accessTokenTTL: 3600,
  refreshTokenTTL: 86400,
  passkeysEnabled: true,
  mfaEnabled: false,
  magicLinkEnabled: true,
  googleSsoEnabled: true,
  linkedinSsoEnabled: false,
  azureAdSsoEnabled: false,
  appleSsoEnabled: false,
  githubSsoEnabled: true,
  facebookSsoEnabled: false,
};

const FLAGS = [{ id: 'f1', key: 'beta-ui', enabled: true, state: 'on', rule: null }];
const PLANS = [
  {
    key: 'pro',
    name: 'Pro',
    trial: true,
    trialDays: 14,
    prices: [{ currency: 'EUR', recurrenceInterval: 'month', amount: 49 }],
    quotas: [{ metric: 'ai_completions', limit: 1000, policy: 'hard' }],
  },
];
const ROLES = [
  {
    id: 'r1',
    key: 'ADMIN',
    name: 'Admin',
    isDefault: false,
    privileges: [{ id: 'p1', key: 'USER_WRITE' }],
  },
];

function httpError(status: number, message: string, body?: unknown): Error {
  return Object.assign(new Error(message), { status, body });
}

function mockCtx(overrides: Record<string, unknown> = {}): ToolContext {
  return {
    management: {
      app: { get: jest.fn().mockResolvedValue(APP) },
      flags: { list: jest.fn().mockResolvedValue(FLAGS) },
      plans: { list: jest.fn().mockResolvedValue(PLANS) },
      roles: { list: jest.fn().mockResolvedValue(ROLES) },
      ...overrides,
    },
  } as unknown as ToolContext;
}

describe('read-tool batch registry', () => {
  it('all five read tools are in the registry', () => {
    const names = bridgeTools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_app',
        'list_feature_flags',
        'list_plans',
        'list_roles',
        'get_auth_config',
        'get_environment_info',
      ]),
    );
  });
});

describe('list_feature_flags', () => {
  it('returns the flag list', async () => {
    const ctx = mockCtx();
    const result = await listFeatureFlagsTool.handler(ctx, {});
    expect(result).toEqual({ success: true, data: { flags: FLAGS } });
  });

  it('maps an HTTP 401 to a failure envelope with a fix hint', async () => {
    const ctx = mockCtx({
      flags: { list: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')) },
    });
    const result = await listFeatureFlagsTool.handler(ctx, {});
    expect(result).toEqual({
      success: false,
      error: {
        code: 'HTTP_401',
        message: 'Unauthorized',
        fix: expect.stringContaining('bridge auth login'),
      },
    });
  });
});

describe('list_plans', () => {
  it('returns plans with prices and quotas intact', async () => {
    const ctx = mockCtx();
    const result = await listPlansTool.handler(ctx, {});
    expect(result).toEqual({ success: true, data: { plans: PLANS } });
    if (result.success) {
      const plans = (result.data as { plans: typeof PLANS }).plans;
      expect(plans[0].prices).toHaveLength(1);
      expect(plans[0].quotas).toHaveLength(1);
    }
  });

  it('prefers the server nblocksCode over HTTP_<status>', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest
          .fn()
          .mockRejectedValue(httpError(400, 'Bad request', { nblocksCode: 'PLAN_CONFIG_INVALID' })),
      },
    });
    const result = await listPlansTool.handler(ctx, {});
    expect(result).toEqual({
      success: false,
      error: { code: 'PLAN_CONFIG_INVALID', message: 'Bad request' },
    });
  });
});

describe('list_roles', () => {
  it('returns roles with privileges', async () => {
    const ctx = mockCtx();
    const result = await listRolesTool.handler(ctx, {});
    expect(result).toEqual({ success: true, data: { roles: ROLES } });
  });

  it('maps an HTTP 403 to a failure envelope with a privileges fix hint', async () => {
    const ctx = mockCtx({
      roles: { list: jest.fn().mockRejectedValue(httpError(403, 'Forbidden')) },
    });
    const result = await listRolesTool.handler(ctx, {});
    expect(result).toEqual({
      success: false,
      error: {
        code: 'HTTP_403',
        message: 'Forbidden',
        fix: expect.stringContaining('privilege'),
      },
    });
  });
});

describe('get_auth_config', () => {
  it('projects login methods and token TTLs from the app config', async () => {
    const ctx = mockCtx();
    const result = await getAuthConfigTool.handler(ctx, {});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        loginMethods: {
          password: { enabled: boolean };
          magicLink: { enabled: boolean };
          passkeys: { enabled: boolean };
          mfa: { enabled: boolean };
          socialProviders: Record<string, { enabled: boolean }>;
        };
        tokens: { accessTokenTTL: number; refreshTokenTTL: number };
      };
      expect(data.loginMethods.password.enabled).toBe(true);
      expect(data.loginMethods.magicLink.enabled).toBe(true);
      expect(data.loginMethods.passkeys.enabled).toBe(true);
      expect(data.loginMethods.mfa.enabled).toBe(false);
      expect(data.loginMethods.socialProviders).toEqual({
        google: { enabled: true },
        linkedin: { enabled: false },
        azureAd: { enabled: false },
        apple: { enabled: false },
        github: { enabled: true },
        facebook: { enabled: false },
      });
      expect(data.tokens).toEqual({ accessTokenTTL: 3600, refreshTokenTTL: 86400 });
    }
  });

  it('maps a non-HTTP error to UNEXPECTED_ERROR', async () => {
    const ctx = mockCtx({
      app: { get: jest.fn().mockRejectedValue(new Error('socket hang up')) },
    });
    const result = await getAuthConfigTool.handler(ctx, {});
    expect(result).toEqual({
      success: false,
      error: { code: 'UNEXPECTED_ERROR', message: 'socket hang up' },
    });
  });
});

describe('get_environment_info', () => {
  it('returns app id, oauth wiring and canonical env-var names', async () => {
    const ctx = mockCtx();
    const result = await getEnvironmentInfoTool.handler(ctx, {});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        appId: string;
        oauth: { redirectUris: string[]; defaultCallbackUri: string; allowedOrigins: string[] };
        envVars: Record<string, Array<{ name: string; value?: string }>>;
      };
      expect(data.appId).toBe('app_123');
      expect(data.oauth.redirectUris).toEqual(APP.redirectUris);
      expect(data.oauth.defaultCallbackUri).toBe(APP.defaultCallbackUri);
      expect(data.oauth.allowedOrigins).toEqual(APP.allowedOrigins);

      const viteAppId = data.envVars.viteFrontends.find((e) => e.name === 'VITE_BRIDGE_APP_ID');
      expect(viteAppId?.value).toBe('app_123');
      expect(data.envVars.nextjs).toEqual([
        { name: 'NEXT_PUBLIC_BRIDGE_APP_ID', value: 'app_123' },
      ]);
      const serverAppId = data.envVars.serverSdks.find((e) => e.name === 'BRIDGE_APP_ID');
      expect(serverAppId?.value).toBe('app_123');
      // The API key name is listed but never carries a value (it is a secret).
      const apiKey = data.envVars.serverSdks.find((e) => e.name === 'BRIDGE_API_KEY');
      expect(apiKey).toBeDefined();
      expect(apiKey?.value).toBeUndefined();
      // Angular is code-configured — no env vars.
      expect(data.envVars.angular).toEqual([]);
    }
  });

  it('maps an HTTP 401 to a failure envelope', async () => {
    const ctx = mockCtx({
      app: { get: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')) },
    });
    const result = await getEnvironmentInfoTool.handler(ctx, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HTTP_401');
    }
  });
});
