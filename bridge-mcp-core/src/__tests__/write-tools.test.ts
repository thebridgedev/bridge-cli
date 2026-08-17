/**
 * TBP-539 step 2b — Unit tests for the write-tool batch.
 *
 * Per tool: the zod schema rejects malformed input with an actionable message,
 * the happy path calls the right BridgeManagement method with the right shape
 * (mocked client), and one error-mapping case. Redirect-uri tools additionally
 * cover the add-preserves-existing and remove-absent semantics (mirroring the
 * CLI's app-redirect-uris.test.ts).
 *
 * Schemas are exercised the same way the MCP SDK consumes them: the raw shape
 * wrapped in z.object(...).
 */
import { z } from 'zod';
import {
  addRedirectUriTool,
  bridgeTools,
  createFeatureFlagTool,
  createPlanTool,
  createRoleTool,
  createTenantTool,
  inviteUserTool,
  removePlanPriceTool,
  removePlanQuotaTool,
  removeRedirectUriTool,
  setPlanPriceTool,
  setPlanQuotaTool,
  setupSsoTool,
  toggleFeatureFlagTool,
  updateAuthMethodsTool,
  updateBrandingTool,
  updateFeatureFlagTool,
  updatePlanTool,
  updateRoleTool,
} from '../index.js';
import type { ToolContext, ToolResult } from '../index.js';

// ── Harness ─────────────────────────────────────────────────────────────────

function httpError(status: number, message: string, body?: unknown): Error {
  return Object.assign(new Error(message), { status, body });
}

function mockCtx(overrides: Record<string, unknown> = {}): ToolContext {
  return {
    management: {
      app: {
        get: jest.fn().mockResolvedValue({ id: 'app_1', redirectUris: [] }),
        update: jest.fn().mockResolvedValue({ id: 'app_1' }),
      },
      flags: {
        list: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'f1' }),
        update: jest.fn().mockResolvedValue({ id: 'f1' }),
        toggle: jest.fn().mockResolvedValue({ id: 'f1' }),
      },
      plans: {
        list: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ key: 'pro' }),
        update: jest.fn().mockResolvedValue({ key: 'pro' }),
      },
      roles: {
        create: jest.fn().mockResolvedValue({ id: 'r1' }),
        update: jest.fn().mockResolvedValue({ id: 'r1' }),
      },
      branding: { update: jest.fn().mockResolvedValue({ bgColor: '#fff' }) },
      tenants: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
      users: { invite: jest.fn().mockResolvedValue({ id: 'u1' }) },
      workflows: {
        setupSSO: jest.fn().mockResolvedValue({
          provider: 'google',
          enabled: true,
          callbackUrl: 'https://auth.example.com/callback',
        }),
      },
      ...overrides,
    },
  } as unknown as ToolContext;
}

/** Parse args the way the MCP SDK does: the raw shape wrapped in z.object. */
function schemaOf<S extends z.ZodRawShape>(tool: { inputSchema: S }) {
  return z.object(tool.inputSchema);
}

function expectFailure(result: ToolResult, code: string): void {
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.code).toBe(code);
}

// ── Registry ────────────────────────────────────────────────────────────────

describe('write-tool registry', () => {
  it('contains all 18 write tools alongside the 6 read tools', () => {
    const names = bridgeTools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_feature_flag',
        'update_feature_flag',
        'toggle_feature_flag',
        'create_plan',
        'update_plan',
        'set_plan_price',
        'remove_plan_price',
        'set_plan_quota',
        'remove_plan_quota',
        'create_role',
        'update_role',
        'update_auth_methods',
        'update_branding',
        'setup_sso',
        'add_redirect_uri',
        'remove_redirect_uri',
        'create_tenant',
        'invite_user',
      ]),
    );
    expect(names).toHaveLength(24);
  });

  it('exposes NO destructive tools', () => {
    const names = bridgeTools.map((t) => t.name);
    for (const name of names) {
      expect(name).not.toMatch(/delete|remove_user|revoke/);
    }
  });
});

// ── Feature flags ───────────────────────────────────────────────────────────

describe('create_feature_flag', () => {
  const schema = schemaOf(createFeatureFlagTool);

  it('schema rejects a missing key with an actionable message', () => {
    const res = schema.safeParse({ state: 'on' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'key')).toBe(true);
    }
  });

  it('schema rejects an unknown rule operator, naming the valid vocabulary', () => {
    const res = schema.safeParse({
      key: 'beta-ui',
      rule: {
        branches: [
          {
            conditions: [{ attribute: 'tenant.plan', operator: 'equals', values: ['Pro'] }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
      },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain("'eq'");
    }
  });

  it('schema rejects a rule without otherwiseValue', () => {
    const res = schema.safeParse({
      key: 'beta-ui',
      rule: { branches: [] },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message).join(' ')).toContain('otherwiseValue');
    }
  });

  it('happy path sends the full FF 2.0 create payload', async () => {
    const ctx = mockCtx();
    const rule = {
      branches: [
        {
          conditions: [{ attribute: 'tenant.plan', operator: 'eq', values: ['Pro'] }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    };
    const args = schema.parse({
      key: 'beta-ui',
      description: 'New UI',
      state: 'on-with-rule',
      valueType: 'boolean',
      onValue: true,
      offValue: false,
      rule,
    });
    const result = await createFeatureFlagTool.handler(ctx, args);
    expect(result.success).toBe(true);
    expect(ctx.management.flags.create).toHaveBeenCalledWith({
      key: 'beta-ui',
      description: 'New UI',
      state: 'on-with-rule',
      valueType: 'boolean',
      onValue: true,
      offValue: false,
      rule,
    });
  });

  it('rejects a semantically invalid rule via auth-core validateRule (INVALID_RULE)', async () => {
    const ctx = mockCtx();
    const result = await createFeatureFlagTool.handler(ctx, {
      key: 'beta-ui',
      rule: {
        // Branch with no conditions — passes the structural zod schema but
        // fails validateRule.
        branches: [{ conditions: [], returnValue: true }],
        otherwiseValue: false,
        rolloutPct: 100,
      },
    });
    expectFailure(result, 'INVALID_RULE');
    if (!result.success) {
      expect(result.error.message).toContain('no conditions');
      expect(ctx.management.flags.create).not.toHaveBeenCalled();
    }
  });

  it('maps an HTTP 401 to a failure envelope with a fix hint', async () => {
    const ctx = mockCtx({
      flags: { create: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')) },
    });
    const result = await createFeatureFlagTool.handler(ctx, { key: 'beta-ui' });
    expectFailure(result, 'HTTP_401');
    if (!result.success) expect(result.error.fix).toContain('bridge auth login');
  });
});

describe('update_feature_flag', () => {
  const schema = schemaOf(updateFeatureFlagTool);

  it('schema rejects a missing id', () => {
    const res = schema.safeParse({ state: 'on' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'id')).toBe(true);
    }
  });

  it('happy path sends only the provided fields; clearRule nulls the rule', async () => {
    const ctx = mockCtx();
    const result = await updateFeatureFlagTool.handler(ctx, {
      id: 'f1',
      state: 'off',
      clearRule: true,
    });
    expect(result.success).toBe(true);
    expect(ctx.management.flags.update).toHaveBeenCalledWith('f1', { state: 'off', rule: null });
  });

  it('prefers the server nblocksCode over HTTP_<status>', async () => {
    const ctx = mockCtx({
      flags: {
        update: jest
          .fn()
          .mockRejectedValue(httpError(400, 'Bad request', { nblocksCode: 'FLAG_KEY_TAKEN' })),
      },
    });
    const result = await updateFeatureFlagTool.handler(ctx, { id: 'f1', key: 'dup' });
    expectFailure(result, 'FLAG_KEY_TAKEN');
  });
});

describe('toggle_feature_flag', () => {
  const schema = schemaOf(toggleFeatureFlagTool);

  it('schema rejects a non-boolean enabled', () => {
    const res = schema.safeParse({ key: 'beta-ui', enabled: 'true' });
    expect(res.success).toBe(false);
  });

  it('resolves the flag id by key and calls toggle', async () => {
    const ctx = mockCtx({
      flags: {
        list: jest.fn().mockResolvedValue([{ id: 'f9', key: 'beta-ui' }]),
        toggle: jest.fn().mockResolvedValue({ id: 'f9', enabled: true }),
      },
    });
    const result = await toggleFeatureFlagTool.handler(ctx, { key: 'beta-ui', enabled: true });
    expect(result.success).toBe(true);
    expect(ctx.management.flags.toggle).toHaveBeenCalledWith('f9', true);
  });

  it('fails with FLAG_NOT_FOUND for an unknown key', async () => {
    const ctx = mockCtx();
    const result = await toggleFeatureFlagTool.handler(ctx, { key: 'nope', enabled: true });
    expectFailure(result, 'FLAG_NOT_FOUND');
    if (!result.success) expect(result.error.fix).toContain('list_feature_flags');
  });

  it('maps an HTTP 403 from the toggle call', async () => {
    const ctx = mockCtx({
      flags: {
        list: jest.fn().mockResolvedValue([{ id: 'f9', key: 'beta-ui' }]),
        toggle: jest.fn().mockRejectedValue(httpError(403, 'Forbidden')),
      },
    });
    const result = await toggleFeatureFlagTool.handler(ctx, { key: 'beta-ui', enabled: false });
    expectFailure(result, 'HTTP_403');
  });
});

// ── Plans ───────────────────────────────────────────────────────────────────

describe('create_plan', () => {
  const schema = schemaOf(createPlanTool);

  it('schema rejects a missing name with an actionable message', () => {
    const res = schema.safeParse({ key: 'pro' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'name')).toBe(true);
    }
  });

  it('creates with empty prices (no server placeholder price)', async () => {
    const ctx = mockCtx();
    const result = await createPlanTool.handler(ctx, {
      key: 'pro',
      name: 'Pro',
      trial: true,
      trialDays: 14,
    });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.create).toHaveBeenCalledWith({
      key: 'pro',
      name: 'Pro',
      description: undefined,
      trial: true,
      trialDays: 14,
      prices: [],
    });
  });

  it('maps an HTTP 401', async () => {
    const ctx = mockCtx({
      plans: { create: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')) },
    });
    const result = await createPlanTool.handler(ctx, { key: 'pro', name: 'Pro' });
    expectFailure(result, 'HTTP_401');
  });
});

describe('update_plan', () => {
  const schema = schemaOf(updatePlanTool);

  it('schema rejects a missing key', () => {
    expect(schema.safeParse({ name: 'Pro' }).success).toBe(false);
  });

  it('sends only the provided fields', async () => {
    const ctx = mockCtx();
    const result = await updatePlanTool.handler(ctx, { key: 'pro', description: 'Best plan' });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', { description: 'Best plan' });
  });

  it('maps an HTTP 404', async () => {
    const ctx = mockCtx({
      plans: { update: jest.fn().mockRejectedValue(httpError(404, 'Not found')) },
    });
    const result = await updatePlanTool.handler(ctx, { key: 'gone', name: 'X' });
    expectFailure(result, 'HTTP_404');
  });
});

describe('set_plan_price', () => {
  const schema = schemaOf(setPlanPriceTool);
  const PLAN = {
    key: 'pro',
    prices: [
      { currency: 'USD', recurrenceInterval: 'month', amount: 10 },
      { currency: 'USD', recurrenceInterval: 'year', amount: 100 },
    ],
  };

  it('schema rejects an invalid interval, naming the valid ones', () => {
    const res = schema.safeParse({ key: 'pro', amount: 10, interval: 'quarterly' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message).join(' ')).toContain("'month'");
    }
  });

  it('upserts by currency + interval, preserving other prices', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockResolvedValue(PLAN),
      },
    });
    const result = await setPlanPriceTool.handler(ctx, {
      key: 'pro',
      amount: 15,
      interval: 'month',
      currency: 'usd',
    });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', {
      prices: [
        { currency: 'USD', recurrenceInterval: 'year', amount: 100 },
        { currency: 'USD', recurrenceInterval: 'month', amount: 15 },
      ],
    });
  });

  it('fails with PLAN_NOT_FOUND listing existing keys', async () => {
    const ctx = mockCtx({
      plans: { list: jest.fn().mockResolvedValue([PLAN]), update: jest.fn() },
    });
    const result = await setPlanPriceTool.handler(ctx, {
      key: 'gone',
      amount: 15,
      interval: 'month',
    });
    expectFailure(result, 'PLAN_NOT_FOUND');
    if (!result.success) expect(result.error.fix).toContain('pro');
    expect(ctx.management.plans.update).not.toHaveBeenCalled();
  });
});

describe('remove_plan_price', () => {
  const PLAN = {
    key: 'pro',
    prices: [{ currency: 'USD', recurrenceInterval: 'month', amount: 10 }],
  };

  it('schema rejects a missing interval', () => {
    expect(schemaOf(removePlanPriceTool).safeParse({ key: 'pro' }).success).toBe(false);
  });

  it('removes exactly the matching price', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockResolvedValue(PLAN),
      },
    });
    const result = await removePlanPriceTool.handler(ctx, { key: 'pro', interval: 'month' });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', { prices: [] });
  });

  it('fails with PRICE_NOT_FOUND when no price matches, listing existing prices', async () => {
    const ctx = mockCtx({
      plans: { list: jest.fn().mockResolvedValue([PLAN]), update: jest.fn() },
    });
    const result = await removePlanPriceTool.handler(ctx, { key: 'pro', interval: 'year' });
    expectFailure(result, 'PRICE_NOT_FOUND');
    if (!result.success) {
      expect(result.error.message).toContain('USD year');
      expect(result.error.fix).toContain('USD month 10');
    }
    expect(ctx.management.plans.update).not.toHaveBeenCalled();
  });
});

describe('set_plan_quota', () => {
  const schema = schemaOf(setPlanQuotaTool);
  const PLAN = {
    key: 'pro',
    prices: [{ currency: 'EUR', recurrenceInterval: 'month', amount: 49 }],
    quotas: [{ metric: 'num.seats', limit: 5, policy: 'hard' }],
  };

  it('schema rejects a non-integer limit with an actionable message', () => {
    const res = schema.safeParse({ key: 'pro', metric: 'num.clicks', limit: 1.5, policy: 'hard' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message).join(' ')).toContain('integer');
    }
  });

  it('upserts a hard quota by metric, preserving others', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockResolvedValue(PLAN),
      },
    });
    const result = await setPlanQuotaTool.handler(ctx, {
      key: 'pro',
      metric: 'num.clicks',
      limit: 1000,
      policy: 'hard',
    });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', {
      quotas: [
        { metric: 'num.seats', limit: 5, policy: 'hard' },
        { metric: 'num.clicks', limit: 1000, policy: 'hard' },
      ],
    });
  });

  it('derives the metered currency from the single plan price currency', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockResolvedValue(PLAN),
      },
    });
    const result = await setPlanQuotaTool.handler(ctx, {
      key: 'pro',
      metric: 'num.clicks',
      limit: 0,
      policy: 'metered',
      priceAmount: 0.01,
    });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', {
      quotas: [
        { metric: 'num.seats', limit: 5, policy: 'hard' },
        {
          metric: 'num.clicks',
          limit: 0,
          policy: 'metered',
          pricing: { amount: 0.01, currency: 'EUR' },
        },
      ],
    });
  });

  it('rejects metered without priceAmount (INVALID_QUOTA), no API write', async () => {
    const ctx = mockCtx({
      plans: { list: jest.fn().mockResolvedValue([PLAN]), update: jest.fn() },
    });
    const result = await setPlanQuotaTool.handler(ctx, {
      key: 'pro',
      metric: 'num.clicks',
      limit: 0,
      policy: 'metered',
    });
    expectFailure(result, 'INVALID_QUOTA');
    expect(ctx.management.plans.update).not.toHaveBeenCalled();
  });

  it('rejects a hard quota carrying priceAmount (INVALID_QUOTA)', async () => {
    const ctx = mockCtx({
      plans: { list: jest.fn().mockResolvedValue([PLAN]), update: jest.fn() },
    });
    const result = await setPlanQuotaTool.handler(ctx, {
      key: 'pro',
      metric: 'num.clicks',
      limit: 100,
      policy: 'hard',
      priceAmount: 0.01,
    });
    expectFailure(result, 'INVALID_QUOTA');
    expect(ctx.management.plans.update).not.toHaveBeenCalled();
  });

  it('maps an HTTP 400 from the update call', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockRejectedValue(httpError(400, 'Bad request')),
      },
    });
    const result = await setPlanQuotaTool.handler(ctx, {
      key: 'pro',
      metric: 'num.clicks',
      limit: 10,
      policy: 'hard',
    });
    expectFailure(result, 'HTTP_400');
  });
});

describe('remove_plan_quota', () => {
  const PLAN = {
    key: 'pro',
    prices: [],
    quotas: [{ metric: 'num.seats', limit: 5, policy: 'hard' }],
  };

  it('schema rejects a missing metric', () => {
    expect(schemaOf(removePlanQuotaTool).safeParse({ key: 'pro' }).success).toBe(false);
  });

  it('removes exactly the named metric', async () => {
    const ctx = mockCtx({
      plans: {
        list: jest.fn().mockResolvedValue([PLAN]),
        update: jest.fn().mockResolvedValue(PLAN),
      },
    });
    const result = await removePlanQuotaTool.handler(ctx, { key: 'pro', metric: 'num.seats' });
    expect(result.success).toBe(true);
    expect(ctx.management.plans.update).toHaveBeenCalledWith('pro', { quotas: [] });
  });

  it('fails with QUOTA_NOT_FOUND for an absent metric, listing existing metrics', async () => {
    const ctx = mockCtx({
      plans: { list: jest.fn().mockResolvedValue([PLAN]), update: jest.fn() },
    });
    const result = await removePlanQuotaTool.handler(ctx, { key: 'pro', metric: 'num.clicks' });
    expectFailure(result, 'QUOTA_NOT_FOUND');
    if (!result.success) expect(result.error.fix).toContain('num.seats');
    expect(ctx.management.plans.update).not.toHaveBeenCalled();
  });
});

// ── Roles ───────────────────────────────────────────────────────────────────

describe('create_role', () => {
  const schema = schemaOf(createRoleTool);

  it('schema rejects a missing key with an actionable message', () => {
    const res = schema.safeParse({ name: 'Admin' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'key')).toBe(true);
    }
  });

  it('creates with defaulted privileges [] and isDefault false', async () => {
    const ctx = mockCtx();
    const result = await createRoleTool.handler(ctx, { name: 'Admin', key: 'ADMIN' });
    expect(result.success).toBe(true);
    expect(ctx.management.roles.create).toHaveBeenCalledWith({
      name: 'Admin',
      key: 'ADMIN',
      description: undefined,
      privileges: [],
      isDefault: false,
    });
  });

  it('passes privileges and isDefault through', async () => {
    const ctx = mockCtx();
    await createRoleTool.handler(ctx, {
      name: 'Viewer',
      key: 'VIEWER',
      privileges: ['READ'],
      isDefault: true,
    });
    expect(ctx.management.roles.create).toHaveBeenCalledWith({
      name: 'Viewer',
      key: 'VIEWER',
      description: undefined,
      privileges: ['READ'],
      isDefault: true,
    });
  });

  it('maps an HTTP 403', async () => {
    const ctx = mockCtx({
      roles: { create: jest.fn().mockRejectedValue(httpError(403, 'Forbidden')) },
    });
    const result = await createRoleTool.handler(ctx, { name: 'Admin', key: 'ADMIN' });
    expectFailure(result, 'HTTP_403');
  });
});

describe('update_role', () => {
  const schema = schemaOf(updateRoleTool);

  it('schema rejects a missing id', () => {
    expect(schema.safeParse({ name: 'Admin' }).success).toBe(false);
  });

  it('sends only the provided fields', async () => {
    const ctx = mockCtx();
    const result = await updateRoleTool.handler(ctx, { id: 'r1', privileges: ['READ', 'WRITE'] });
    expect(result.success).toBe(true);
    expect(ctx.management.roles.update).toHaveBeenCalledWith('r1', {
      privileges: ['READ', 'WRITE'],
    });
  });

  it('maps an HTTP 404', async () => {
    const ctx = mockCtx({
      roles: { update: jest.fn().mockRejectedValue(httpError(404, 'Not found')) },
    });
    const result = await updateRoleTool.handler(ctx, { id: 'gone', name: 'X' });
    expectFailure(result, 'HTTP_404');
  });
});

// ── Auth methods ────────────────────────────────────────────────────────────

describe('update_auth_methods', () => {
  const schema = schemaOf(updateAuthMethodsTool);

  it('schema rejects a non-boolean toggle', () => {
    expect(schema.safeParse({ mfaEnabled: 'yes' }).success).toBe(false);
  });

  it('sends only the provided toggles and returns the projection', async () => {
    const ctx = mockCtx({
      app: {
        update: jest.fn().mockResolvedValue({
          mfaEnabled: false,
          passkeysEnabled: true,
          magicLinkEnabled: true,
        }),
      },
    });
    const result = await updateAuthMethodsTool.handler(ctx, { passkeysEnabled: true });
    expect(ctx.management.app.update).toHaveBeenCalledWith({ passkeysEnabled: true });
    expect(result).toEqual({
      success: true,
      data: { mfaEnabled: false, passkeysEnabled: true, magicLinkEnabled: true },
    });
  });

  it('fails with NO_FIELDS when no toggle is passed', async () => {
    const ctx = mockCtx();
    const result = await updateAuthMethodsTool.handler(ctx, {});
    expectFailure(result, 'NO_FIELDS');
    expect(ctx.management.app.update).not.toHaveBeenCalled();
  });

  it('maps an HTTP 401', async () => {
    const ctx = mockCtx({
      app: { update: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')) },
    });
    const result = await updateAuthMethodsTool.handler(ctx, { mfaEnabled: true });
    expectFailure(result, 'HTTP_401');
  });
});

// ── Branding ────────────────────────────────────────────────────────────────

describe('update_branding', () => {
  const schema = schemaOf(updateBrandingTool);

  it('schema rejects an empty-string color', () => {
    expect(schema.safeParse({ bgColor: '' }).success).toBe(false);
  });

  it('sends only the provided branding fields', async () => {
    const ctx = mockCtx();
    const result = await updateBrandingTool.handler(ctx, {
      bgColor: '#1a1a2e',
      borderRadius: '8px',
    });
    expect(result.success).toBe(true);
    expect(ctx.management.branding.update).toHaveBeenCalledWith({
      bgColor: '#1a1a2e',
      borderRadius: '8px',
    });
  });

  it('fails with NO_FIELDS when nothing is passed', async () => {
    const ctx = mockCtx();
    const result = await updateBrandingTool.handler(ctx, {});
    expectFailure(result, 'NO_FIELDS');
    expect(ctx.management.branding.update).not.toHaveBeenCalled();
  });

  it('maps an HTTP 403', async () => {
    const ctx = mockCtx({
      branding: { update: jest.fn().mockRejectedValue(httpError(403, 'Forbidden')) },
    });
    const result = await updateBrandingTool.handler(ctx, { bgColor: '#fff' });
    expectFailure(result, 'HTTP_403');
  });
});

// ── SSO ─────────────────────────────────────────────────────────────────────

describe('setup_sso', () => {
  const schema = schemaOf(setupSsoTool);

  it('schema rejects an unknown provider, naming the valid ones', () => {
    const res = schema.safeParse({ provider: 'okta' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message).join(' ')).toContain("'google'");
    }
  });

  it('calls the setupSSO workflow and surfaces the callback URL', async () => {
    const ctx = mockCtx();
    const result = await setupSsoTool.handler(ctx, {
      provider: 'google',
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(ctx.management.workflows.setupSSO).toHaveBeenCalledWith({
      provider: 'google',
      config: {
        clientId: 'cid',
        clientSecret: 'secret',
        metadataUrl: undefined,
        discoveryUrl: undefined,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { callbackUrl: string }).callbackUrl).toBe(
        'https://auth.example.com/callback',
      );
    }
  });

  it('maps an HTTP 400', async () => {
    const ctx = mockCtx({
      workflows: { setupSSO: jest.fn().mockRejectedValue(httpError(400, 'Bad credentials')) },
    });
    const result = await setupSsoTool.handler(ctx, { provider: 'github', clientId: 'x' });
    expectFailure(result, 'HTTP_400');
  });
});

// ── Redirect URIs (mirrors the CLI's app-redirect-uris.test.ts semantics) ───

describe('add_redirect_uri', () => {
  const schema = schemaOf(addRedirectUriTool);

  it('schema rejects an empty url', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('appends the new URL while preserving every existing entry', async () => {
    const existing = [
      'https://app.example.com/auth/oauth-callback',
      'https://staging.example.com/auth/oauth-callback',
    ];
    const added = 'https://preview.example.com/auth/oauth-callback';
    const ctx = mockCtx({
      app: {
        get: jest.fn().mockResolvedValue({ redirectUris: existing }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const result = await addRedirectUriTool.handler(ctx, { url: added });
    // Regression guard: `add` must never replace the list wholesale.
    expect(ctx.management.app.update).toHaveBeenCalledWith({
      redirectUris: [...existing, added],
    });
    expect(result).toEqual({
      success: true,
      data: { added: true, redirectUris: [...existing, added] },
    });
  });

  it('is a success no-op for an already-registered URL', async () => {
    const existing = ['https://app.example.com/auth/oauth-callback'];
    const ctx = mockCtx({
      app: {
        get: jest.fn().mockResolvedValue({ redirectUris: existing }),
        update: jest.fn(),
      },
    });
    const result = await addRedirectUriTool.handler(ctx, { url: existing[0] });
    expect(ctx.management.app.update).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { added: boolean }).added).toBe(false);
      expect((result.data as { message: string }).message).toMatch(/Already registered/);
    }
  });

  it('rejects a relative URL before any API call (INVALID_REDIRECT_URI)', async () => {
    const ctx = mockCtx();
    const result = await addRedirectUriTool.handler(ctx, { url: '/auth/callback' });
    expectFailure(result, 'INVALID_REDIRECT_URI');
    if (!result.success) expect(result.error.message).toContain('not an absolute URL');
    expect(ctx.management.app.get).not.toHaveBeenCalled();
    expect(ctx.management.app.update).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme before any API call', async () => {
    const ctx = mockCtx();
    const result = await addRedirectUriTool.handler(ctx, { url: 'ftp://example.com/cb' });
    expectFailure(result, 'INVALID_REDIRECT_URI');
    if (!result.success) expect(result.error.message).toContain('must use http or https');
    expect(ctx.management.app.get).not.toHaveBeenCalled();
  });

  it('maps an HTTP 401 from the read', async () => {
    const ctx = mockCtx({
      app: { get: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')), update: jest.fn() },
    });
    const result = await addRedirectUriTool.handler(ctx, {
      url: 'https://app.example.com/cb',
    });
    expectFailure(result, 'HTTP_401');
  });
});

describe('remove_redirect_uri', () => {
  it('removes exactly the named entry and keeps the rest', async () => {
    const existing = [
      'https://app.example.com/auth/oauth-callback',
      'http://localhost:8080/cb',
    ];
    const ctx = mockCtx({
      app: {
        get: jest.fn().mockResolvedValue({ redirectUris: existing }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const result = await removeRedirectUriTool.handler(ctx, { url: existing[0] });
    expect(ctx.management.app.update).toHaveBeenCalledWith({
      redirectUris: [existing[1]],
    });
    expect(result).toEqual({
      success: true,
      data: { removed: true, redirectUris: [existing[1]] },
    });
  });

  it('fails for an absent URL, listing the registered URIs, without writing', async () => {
    const existing = ['https://app.example.com/auth/oauth-callback'];
    const ctx = mockCtx({
      app: {
        get: jest.fn().mockResolvedValue({ redirectUris: existing }),
        update: jest.fn(),
      },
    });
    const result = await removeRedirectUriTool.handler(ctx, {
      url: 'https://gone.example.com/cb',
    });
    expectFailure(result, 'REDIRECT_URI_NOT_REGISTERED');
    if (!result.success) expect(result.error.message).toContain(existing[0]);
    expect(ctx.management.app.update).not.toHaveBeenCalled();
  });

  it('reports "(none)" when nothing is registered at all', async () => {
    const ctx = mockCtx({
      app: { get: jest.fn().mockResolvedValue({}), update: jest.fn() },
    });
    const result = await removeRedirectUriTool.handler(ctx, {
      url: 'https://gone.example.com/cb',
    });
    expectFailure(result, 'REDIRECT_URI_NOT_REGISTERED');
    if (!result.success) expect(result.error.message).toContain('(none)');
  });

  it('maps an HTTP 401 from the read', async () => {
    const ctx = mockCtx({
      app: { get: jest.fn().mockRejectedValue(httpError(401, 'Unauthorized')), update: jest.fn() },
    });
    const result = await removeRedirectUriTool.handler(ctx, {
      url: 'https://app.example.com/cb',
    });
    expectFailure(result, 'HTTP_401');
  });
});

// ── Tenants + users ─────────────────────────────────────────────────────────

describe('create_tenant', () => {
  const schema = schemaOf(createTenantTool);

  it('schema rejects a malformed ownerEmail with an actionable message', () => {
    const res = schema.safeParse({ ownerEmail: 'not-an-email' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message).join(' ')).toContain('valid email');
    }
  });

  it('sends the CLI-shaped create payload (owner.email nesting)', async () => {
    const ctx = mockCtx();
    const result = await createTenantTool.handler(ctx, {
      ownerEmail: 'owner@example.com',
      name: 'Acme',
      plan: 'pro',
      locale: 'en',
    });
    expect(result.success).toBe(true);
    expect(ctx.management.tenants.create).toHaveBeenCalledWith({
      owner: { email: 'owner@example.com' },
      name: 'Acme',
      plan: 'pro',
      locale: 'en',
    });
  });

  it('maps an HTTP 400 with nblocksCode', async () => {
    const ctx = mockCtx({
      tenants: {
        create: jest
          .fn()
          .mockRejectedValue(httpError(400, 'Plan missing', { nblocksCode: 'PLAN_NOT_FOUND' })),
      },
    });
    const result = await createTenantTool.handler(ctx, { ownerEmail: 'owner@example.com' });
    expectFailure(result, 'PLAN_NOT_FOUND');
  });
});

describe('invite_user', () => {
  const schema = schemaOf(inviteUserTool);

  it('schema rejects a missing tenantId with an actionable message', () => {
    const res = schema.safeParse({ email: 'user@example.com' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'tenantId')).toBe(true);
    }
  });

  it('maps email → username in the invite payload (CLI shape)', async () => {
    const ctx = mockCtx();
    const result = await inviteUserTool.handler(ctx, {
      tenantId: 't1',
      email: 'user@example.com',
      role: 'ADMIN',
      firstName: 'Ada',
    });
    expect(result.success).toBe(true);
    expect(ctx.management.users.invite).toHaveBeenCalledWith('t1', {
      username: 'user@example.com',
      role: 'ADMIN',
      firstName: 'Ada',
      lastName: undefined,
    });
  });

  it('maps an HTTP 404 (unknown tenant)', async () => {
    const ctx = mockCtx({
      users: { invite: jest.fn().mockRejectedValue(httpError(404, 'Tenant not found')) },
    });
    const result = await inviteUserTool.handler(ctx, {
      tenantId: 'gone',
      email: 'user@example.com',
    });
    expectFailure(result, 'HTTP_404');
  });
});
