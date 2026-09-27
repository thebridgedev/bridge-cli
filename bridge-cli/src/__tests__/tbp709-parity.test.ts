/**
 * TBP-709 — the command line shows the same warnings, takes the same dry-run,
 * shapes the same lists and offers the same plan call as the MCP tools.
 *
 * Each block mirrors a bridge-api MCP spec (mcp/tools/__tests__/
 * flag-coherence.spec.ts, shape.spec.ts, destructive-preview.spec.ts,
 * apply-plan.spec.ts) and asserts the same behaviour — the warning strings
 * are the same strings.
 */

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  getManagementHttp: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { Command } from 'commander';
import { getManagementClient, getManagementHttp } from '../config';
import { flagCoherenceWarnings, type CoherenceCatalog } from '../flag-coherence';
import { shapePlan, shapeRoleList, shapeTenant } from '../shape';
import { registerFlagCommands } from '../commands/flag.command';
import { registerTenantCommands } from '../commands/tenant.command';
import { registerUserCommands } from '../commands/user.command';
import { registerTokenCommands } from '../commands/token.command';
import { registerRoleCommands } from '../commands/role.command';
import { planApplyWrite, registerPlanCommands } from '../commands/plan.command';

const mockClient = getManagementClient as jest.Mock;
const mockHttp = getManagementHttp as jest.Mock;

async function runCli(...args: string[]) {
  let stdout = '';
  let stderr = '';
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout += String(c); return true; });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr += String(c); return true; });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  for (const register of [registerFlagCommands, registerTenantCommands, registerUserCommands,
    registerTokenCommands, registerRoleCommands, registerPlanCommands]) register(program);
  try {
    await program.parseAsync(['node', 'bridge', ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return {
    stdout, stderr, exitCode,
    data: stdout ? JSON.parse(stdout).data : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}

beforeEach(() => jest.resetAllMocks());

// ── C: coherence warnings ───────────────────────────────────────────────────

const CATALOG: CoherenceCatalog = {
  plans: [{ key: 'free', name: 'Free' }, { key: 'pro', name: 'Pro' }],
  roles: [{ key: 'OWNER', name: 'Owner' }, { key: 'ADMIN', name: 'Admin' }],
};
const ON_FALSE =
  'Flag "beta" is switched on, but its onValue is false, so it returns false for everyone: ' +
  'it looks on and behaves off. Set onValue to true, or switch the flag off.';
const DANGLING_PLAN =
  'Flag "premium-features" has a rule on tenant.plan eq "premium", but the app has no plan ' +
  '"premium", so no real workspace can carry it. Existing plan keys: free, pro.';

function planRule(value: string, attribute = 'tenant.plan', operator = 'eq') {
  return {
    branches: [{ conditions: [{ attribute, operator, values: [value] }], returnValue: true }],
    otherwiseValue: false,
    rolloutPct: 100,
  } as never;
}

describe('C — the same warnings', () => {
  it('pure rules: same strings as the MCP, and a coherent flag gets none', () => {
    expect(flagCoherenceWarnings({ key: 'beta', state: 'on', valueType: 'boolean', onValue: false, offValue: false })).toEqual([ON_FALSE]);
    expect(flagCoherenceWarnings({ key: 'premium-features', state: 'on-with-rule', rule: planRule('premium') }, CATALOG)).toEqual([DANGLING_PLAN]);
    expect(flagCoherenceWarnings({ key: 'f', state: 'on-with-rule', rule: planRule('EDITOR', 'user.role', 'in') }, CATALOG)).toEqual([
      'Flag "f" has a rule on user.role in "EDITOR", but the app has no role "EDITOR", so no real user ' +
        'can carry it. Existing role keys: OWNER, ADMIN.',
    ]);
    expect(flagCoherenceWarnings({ key: 'ok', state: 'on', valueType: 'boolean', onValue: true, offValue: false }, CATALOG)).toEqual([]);
    expect(flagCoherenceWarnings({ key: 'f', state: 'on-with-rule', rule: planRule('pro') }, CATALOG)).toEqual([]);
    // Rules compare the plan KEY: a display name never matches, and says which key to use.
    expect(flagCoherenceWarnings({ key: 'f', state: 'on-with-rule', rule: planRule('Pro') }, CATALOG)).toEqual([
      'Flag "f" has a rule on tenant.plan eq "Pro", which matches the plan named "Pro" by name; ' +
        'rules compare the plan key — use "pro".',
    ]);
    expect(flagCoherenceWarnings({ key: 'f', state: 'on-with-rule', rule: planRule('Admin', 'user.role') }, CATALOG)).toEqual([
      'Flag "f" has a rule on user.role eq "Admin", which matches the role named "Admin" by name; ' +
        'rules compare the role key — use "ADMIN".',
    ]);
  });

  function flagClient(flags: any[]) {
    const client = {
      flags: {
        list: jest.fn().mockResolvedValue(flags),
        create: jest.fn(async (p: any) => ({ id: 'new', ...p })),
        update: jest.fn(async (id: string, p: any) => ({ ...flags.find((f) => f.id === id), ...p })),
      },
      plans: { list: jest.fn().mockResolvedValue([{ key: 'free', name: 'Free' }, { key: 'pro', name: 'Pro' }]) },
      roles: { list: jest.fn().mockResolvedValue([{ key: 'OWNER', name: 'Owner' }]) },
    };
    mockClient.mockReturnValue(client);
    return client;
  }
  const onFalse = { id: 'f1', key: 'beta', state: 'on', valueType: 'boolean', onValue: false, offValue: false };
  const dangling = { id: 'f2', key: 'premium-features', state: 'on-with-rule', valueType: 'boolean', onValue: true, offValue: false, rule: planRule('premium') };
  const coherent = { id: 'f3', key: 'ok', state: 'on', valueType: 'boolean', onValue: true, offValue: false };

  it('flag get / list / eval carry them only where they apply', async () => {
    flagClient([onFalse, dangling, coherent]);
    expect((await runCli('flag', 'get', 'beta')).data.warnings).toEqual([ON_FALSE]);
    expect((await runCli('flag', 'get', 'ok')).data.warnings).toBeUndefined();
    const rows = (await runCli('flag', 'list')).data;
    expect(rows.map((r: any) => r.warnings)).toEqual([[ON_FALSE], [DANGLING_PLAN], undefined]);
    const evald = (await runCli('flag', 'eval', 'premium-features', '--attribute', 'tenant.plan=premium')).data;
    expect(evald.result.value).toBe(true);
    expect(evald.warnings).toEqual([DANGLING_PLAN]);
    expect((await runCli('flag', 'eval', 'ok')).data.warnings).toEqual([]);
  });

  it('flag create writes and warns — a warning never blocks', async () => {
    const client = flagClient([]);
    const res = await runCli('flag', 'create', '--key', 'premium-features', '--state', 'on-with-rule',
      '--rule', JSON.stringify(planRule('premium')));
    expect(client.flags.create).toHaveBeenCalledTimes(1);
    expect(res.data.warnings).toEqual([DANGLING_PLAN]);
  });
});

// ── D: the same shaping ─────────────────────────────────────────────────────

const TENANT = {
  id: 't1', name: 'Acme', plan: 'pro',
  metadata: {
    crmId: 'c-42',
    pendingPixelEvents: { signup: { conversion_id: 'uuid-1' } },
    conversionTracking: { signup_method: 'email' },
  },
};
const PLAN = {
  key: 'pro', name: 'Pro', prices: [{ amount: 10, currency: 'USD', recurrenceInterval: 'month' }],
  quotas: [{ metric: 'api.calls', limit: 0, policy: 'metered', pricing: { amount: 1, currency: 'USD' },
    providerRefs: { stripePriceId: 'price_123', stripeMeterId: 'mtr_456' } }],
};
const ROLES = [
  { id: 'r1', key: 'OWNER', name: 'Owner', isDefault: false, privileges: [
    { id: 'p1', key: 'USER_READ', description: 'Read users' }, { id: 'p2', key: 'USER_WRITE', description: 'Write users' }] },
  { id: 'r2', key: 'VIEWER', name: 'Viewer', isDefault: true, privileges: [{ id: 'p1', key: 'USER_READ', description: 'Read users' }] },
];

describe('D — the same shaping', () => {
  it('pure functions match the MCP output', () => {
    expect(shapeTenant(TENANT)).toEqual({ id: 't1', name: 'Acme', plan: 'pro', metadata: { crmId: 'c-42' } });
    expect(JSON.stringify(shapePlan(PLAN))).not.toContain('providerRefs');
    expect(shapeRoleList(ROLES).privileges).toEqual({ USER_READ: 'Read users', USER_WRITE: 'Write users' });
  });

  it('tenant list / plan list / plan get / role list print no internals', async () => {
    mockClient.mockReturnValue({
      tenants: { list: jest.fn().mockResolvedValue([TENANT]) },
      plans: { list: jest.fn().mockResolvedValue([PLAN]) },
      roles: { list: jest.fn().mockResolvedValue(ROLES) },
    });
    const tenants = JSON.stringify((await runCli('tenant', 'list')).data);
    expect(tenants).not.toContain('pendingPixelEvents');
    expect(tenants).not.toContain('conversion_id');
    expect(tenants).toContain('crmId');
    for (const args of [['plan', 'list'], ['plan', 'get', 'pro'], ['plan', 'quota', 'list', 'pro']]) {
      const text = JSON.stringify((await runCli(...args)).data);
      expect(text).not.toContain('price_123');
      expect(text).toContain('api.calls');
    }
    const roles = (await runCli('role', 'list')).data;
    expect(roles.roles.map((r: any) => r.privileges)).toEqual([['USER_READ', 'USER_WRITE'], ['USER_READ']]);
    expect(roles.privileges).toEqual({ USER_READ: 'Read users', USER_WRITE: 'Write users' });
  });
});

// ── E: the same dry run ─────────────────────────────────────────────────────

const PREVIEW = { dryRun: true, target: { id: 'x' }, affects: { n: 1 }, sideEffects: ['s'] };

describe('E — the same dry run', () => {
  it.each([
    [['tenant', 'delete', '--id', 'ten_1', '--dry-run'], '/v1/account/tenant/ten_1?dryRun=true', undefined, 'tenants', 'delete'],
    [['user', 'remove', '--user-id', 'u_1', '--tenant-id', 'ten_1', '--dry-run'], '/v1/account/tenant/user/u_1?dryRun=true', { 'x-tenant-id': 'ten_1' }, 'users', 'remove'],
    [['flag', 'delete', '--id', 'flag_1', '--dry-run'], '/v1/admin/flags/flag/flag_1?dryRun=true', undefined, 'flags', 'delete'],
    [['token', 'revoke', '--id', 'tok_1', '--dry-run'], '/v1/account/api-token/app/tok_1?dryRun=true', undefined, 'tokens', 'revoke'],
  ])('%j asks the delete route for its preview and deletes nothing', async (args, path, headers, noun, verb) => {
    const del = jest.fn();
    mockClient.mockReturnValue({ [noun]: { [verb]: del } });
    const http = { delete: jest.fn().mockResolvedValue(PREVIEW) };
    mockHttp.mockReturnValue(http);
    const res = await runCli(...(args as string[]));
    expect(del).not.toHaveBeenCalled();
    expect(http.delete).toHaveBeenCalledWith(path, headers);
    expect(res.data).toEqual(expect.objectContaining(PREVIEW));
    expect(res.data.next).toContain('Nothing was changed');
  });

  it('without --dry-run the command still deletes', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    mockClient.mockReturnValue({ tenants: { delete: del } });
    mockHttp.mockReturnValue({ delete: jest.fn() });
    await runCli('tenant', 'delete', '--id', 'ten_1');
    expect(del).toHaveBeenCalledWith('ten_1');
  });
});

// ── G: the same plan call ───────────────────────────────────────────────────

const PRO = {
  key: 'pro', name: 'Pro', trial: false,
  prices: [{ amount: 10, currency: 'USD', recurrenceInterval: 'month' }],
  quotas: [
    { metric: 'projects', limit: 5, policy: 'hard', kind: 'gauge' },
    { metric: 'api.calls', limit: 0, policy: 'metered', pricing: { amount: 1, currency: 'USD' },
      providerRefs: { stripePriceId: 'price_1', stripeMeterId: 'mtr_1' } },
  ],
};

describe('G — the same plan call', () => {
  it('creates a new plan with prices and quotas in one write', () => {
    const w = planApplyWrite({
      key: 'team', name: 'Team', trial: true, trialDays: 14,
      prices: [{ amount: 20, interval: 'month' }, { amount: 200, interval: 'year', currency: 'usd' }],
      quotas: [{ metric: 'projects', limit: 10, policy: 'hard', kind: 'gauge' }, { metric: 'users', limit: 5, policy: 'hard' }],
    }, []);
    expect(w.created).toBe(true);
    expect(w.body).toEqual({
      key: 'team', name: 'Team', trial: true, trialDays: 14,
      prices: [
        { amount: 20, currency: 'USD', recurrenceInterval: 'month' },
        { amount: 200, currency: 'USD', recurrenceInterval: 'year' },
      ],
      quotas: [
        { metric: 'projects', limit: 10, policy: 'hard', kind: 'gauge' },
        { metric: 'users', limit: 5, policy: 'hard', kind: 'gauge' },
      ],
    });
  });

  it('reshapes an existing plan, keeping what it is not told about (Stripe ids included for the server)', () => {
    const w = planApplyWrite({
      key: 'pro', name: 'Pro Plus', prices: [{ amount: 100, interval: 'year' }],
      quotas: [{ metric: 'projects', limit: 50, policy: 'hard' }],
    }, [PRO]);
    expect(w.created).toBe(false);
    expect(w.body.prices).toEqual([
      { amount: 10, currency: 'USD', recurrenceInterval: 'month' },
      { amount: 100, currency: 'USD', recurrenceInterval: 'year' },
    ]);
    expect(w.body.quotas).toEqual([PRO.quotas[1], { metric: 'projects', limit: 50, policy: 'hard', kind: 'gauge' }]);
    expect(planApplyWrite({ key: 'pro', description: 'Best' }, [PRO]).body).toEqual({ description: 'Best' });
  });

  it.each([
    [{ key: 'pro', removePrices: [{ interval: 'month' }] }, 'LAST_PRICE'],
    [{ key: 'pro', removePrices: [{ interval: 'week' }] }, 'PRICE_NOT_FOUND'],
    [{ key: 'pro', removeQuotas: ['nope'] }, 'QUOTA_NOT_FOUND'],
    [{ key: 'new', name: 'New' }, 'PLAN_NEEDS_PRICE'],
    [{ key: 'new', prices: [{ amount: 0, interval: 'month' }] }, 'PLAN_NEEDS_NAME'],
    [{ key: 'pro', quotas: [{ metric: 'projects', limit: 1, policy: 'metered', priceAmount: 1 }] }, 'INVALID_QUOTA'],
    [{ key: 'pro', quotas: [{ metric: 'users', limit: 1, policy: 'hard', kind: 'counter' }] }, 'INVALID_QUOTA'],
  ])('refuses %j with %s', (spec, code) => {
    expect(() => planApplyWrite(spec as never, [PRO])).toThrow(expect.objectContaining({ code }));
  });

  it('`bridge plan apply --spec` makes one write and prints the shaped plan', async () => {
    const client = {
      plans: {
        list: jest.fn().mockResolvedValue([PRO]),
        create: jest.fn(),
        update: jest.fn(async (_k: string, b: any) => ({ ...PRO, ...b })),
      },
    };
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'apply', '--spec', JSON.stringify({ key: 'pro', prices: [{ amount: 100, interval: 'year' }] }));
    expect(client.plans.update).toHaveBeenCalledTimes(1);
    expect(client.plans.create).not.toHaveBeenCalled();
    expect(res.data.created).toBe(false);
    expect(JSON.stringify(res.data)).not.toContain('providerRefs');
  });

  it('`bridge plan apply` refuses before writing, with the code', async () => {
    const client = { plans: { list: jest.fn().mockResolvedValue([PRO]), create: jest.fn(), update: jest.fn() } };
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'apply', '--spec', JSON.stringify({ key: 'pro', removeQuotas: ['nope'] }));
    expect(res.error.code).toBe('QUOTA_NOT_FOUND');
    expect(client.plans.update).not.toHaveBeenCalled();
  });

  it('`bridge plan quota list` always lists the built-in seats gauge', async () => {
    mockClient.mockReturnValue({ plans: { list: jest.fn().mockResolvedValue([PRO]) } });
    const metrics = (await runCli('plan', 'quota', 'list')).data;
    expect(metrics.map((m: any) => m.metric)).toEqual(['api.calls', 'projects', 'users']);
    expect(metrics[2]).toEqual({ metric: 'users', kind: 'gauge', builtIn: true, plans: [] });
  });
});
