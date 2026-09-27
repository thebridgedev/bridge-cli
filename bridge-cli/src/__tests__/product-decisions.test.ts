/**
 * TBP-713 — the commands that mirror the MCP tools stop on a product decision
 * the developer has not made: exit non-zero with DECISION_NEEDED, list the
 * same fields the MCP tool names, and write nothing. They never default one.
 *
 * The field names asserted here are the ones bridge-api's
 * mcp/tools/__tests__/product-decisions.spec.ts asserts for the MCP tools.
 */
jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  getManagementHttp: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerPlanCommands, planApplyWrite } from '../commands/plan.command';
import { registerUserCommands } from '../commands/user.command';
import { loadProductDecisions, DecisionNeededError } from '../product-decisions';

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
  registerPlanCommands(program);
  registerUserCommands(program);
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

const names = (error: { fields?: Array<{ name: string }> }) => (error.fields ?? []).map((f) => f.name);

function planClient(plans: unknown[] = []) {
  return {
    plans: {
      list: jest.fn().mockResolvedValue(plans),
      create: jest.fn(async (p: any) => ({ ...p })),
      update: jest.fn(async (_k: string, p: any) => ({ key: _k, ...p })),
    },
  };
}

beforeEach(() => jest.resetAllMocks());

describe('prompts/product-decisions.json (generated from bridge-api)', () => {
  it('loads, and holds the asked decisions the commands enforce', () => {
    const asked = loadProductDecisions().filter((d) => d.enforcement === 'ask').map((d) => `${d.cli}:${d.field}`);
    expect(asked).toEqual(expect.arrayContaining([
      'bridge plan create:currency', 'bridge plan create:trial', 'bridge plan apply:prices.currency',
      'bridge plan price set:currency', 'bridge user invite:role',
    ]));
  });

  // The same agreement bridge-api's guide-currency.spec.ts checks, runnable here without it.
  const DECISIONS = join(__dirname, '..', '..', 'prompts', 'decisions');
  const LINES = { ask: '**The tools will not guess these.**', 'only-when-given': '**Only changed when you pass them.**' } as const;
  const listed = (text: string, enforcement: keyof typeof LINES) => {
    const ask = text.split('## Ask the developer')[1].split('\n## ')[0];
    const line = ask.split('\n').find((l) => l.startsWith(LINES[enforcement])) ?? '';
    return [...line.matchAll(/`([a-z]+(?:_[a-z]+)+)` \(([^)]*)\)/g)]
      .flatMap((m) => [...m[2].matchAll(/`([A-Za-z][\w.]*)`/g)].map((f) => `${m[1]}.${f[1]}`))
      .sort();
  };
  const cases = readdirSync(DECISIONS).filter((f) => f.endsWith('.md'))
    .flatMap((f) => (['ask', 'only-when-given'] as const).map((e) => [f.replace(/\.md$/, ''), e] as const));
  it.each(cases)('decisions/%s.md lists exactly the %s decisions in the JSON', (guide, enforcement) => {
    const text = readFileSync(join(DECISIONS, `${guide}.md`), 'utf-8');
    const expected = loadProductDecisions()
      .filter((d) => d.guide === guide && d.enforcement === enforcement)
      .map((d) => `${d.tool}.${d.field}`)
      .sort();
    expect(listed(text, enforcement)).toEqual(expected);
  });
});

describe('bridge plan create asks instead of guessing', () => {
  it('a paid plan without --currency or --trial/--no-trial exits 1 naming both, and writes nothing', async () => {
    const client = planClient();
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'create', '--key', 'pro', '--name', 'Pro', '--amount', '29', '--interval', 'month');
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('DECISION_NEEDED');
    expect(names(res.error)).toEqual(['currency', 'trial']);
    expect(res.error.fields[1].flag).toBe('--trial | --no-trial');
    expect(res.error.hint).toMatch(/Ask the developer.*--currency <code> --trial \| --no-trial/);
    expect(res.error.hint).toContain('bridge guide decision payments');
    expect(client.plans.create).not.toHaveBeenCalled();
  });

  it('no price at all names price, interval, currency and trial', async () => {
    const client = planClient();
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'create', '--key', 'pro', '--name', 'Pro');
    expect(names(res.error)).toEqual(['amount', 'interval', 'currency', 'trial']);
    expect(client.plans.create).not.toHaveBeenCalled();
  });

  it('--trial without --trial-days asks for the length', async () => {
    const client = planClient();
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'create', '--key', 'pro', '--name', 'Pro', '--amount', '29', '--interval', 'month', '--currency', 'eur', '--trial');
    expect(names(res.error)).toEqual(['trialDays']);
    expect(client.plans.create).not.toHaveBeenCalled();
  });

  it('with every decision made, creates exactly what was asked', async () => {
    const client = planClient();
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'create', '--key', 'pro', '--name', 'Pro', '--amount', '29', '--interval', 'month', '--currency', 'sek', '--no-trial');
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.create).toHaveBeenCalledWith(expect.objectContaining({
      trial: false, prices: [{ amount: 29, currency: 'SEK', recurrenceInterval: 'month' }],
    }));
  });

  it('a free plan needs no currency or trial answer', async () => {
    const client = planClient();
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'create', '--key', 'free', '--name', 'Free', '--amount', '0', '--interval', 'month');
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.create).toHaveBeenCalledWith(expect.objectContaining({
      trial: false, prices: [{ amount: 0, currency: 'USD', recurrenceInterval: 'month' }],
    }));
  });
});

describe('bridge plan price set asks for a currency the plan does not settle', () => {
  const plan = (currencies: string[]) => ({
    key: 'pro', name: 'Pro',
    prices: currencies.map((c, i) => ({ amount: 10 + i, currency: c, recurrenceInterval: i ? 'year' : 'month' })),
  });

  it("reuses the plan's one currency", async () => {
    const client = planClient([plan(['EUR'])]);
    mockClient.mockReturnValue(client);
    await runCli('plan', 'price', 'set', 'pro', '--amount', '100', '--interval', 'year');
    expect(client.plans.update).toHaveBeenCalledWith('pro', {
      prices: [
        { amount: 10, currency: 'EUR', recurrenceInterval: 'month' },
        { amount: 100, currency: 'EUR', recurrenceInterval: 'year' },
      ],
    });
  });

  it('a plan in two currencies exits 1 naming currency, and writes nothing', async () => {
    const client = planClient([plan(['USD', 'EUR'])]);
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'price', 'set', 'pro', '--amount', '100', '--interval', 'week');
    expect(res.exitCode).toBe(1);
    expect(names(res.error)).toEqual(['currency']);
    expect(client.plans.update).not.toHaveBeenCalled();
  });
});

describe('bridge plan apply reports the same fields as apply_plan', () => {
  const PRO = { key: 'pro', name: 'Pro', trial: false, prices: [{ amount: 10, currency: 'USD', recurrenceInterval: 'month' }], quotas: [] };
  const fieldsOf = (spec: object) => {
    try {
      planApplyWrite(spec as never, [PRO]);
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionNeededError);
      return (err as DecisionNeededError).fields.map((f) => f.name);
    }
    throw new Error('expected DECISION_NEEDED');
  };

  it.each([
    [{ key: 'team' }, ['name', 'prices[0].amount', 'prices[0].interval', 'prices[0].currency', 'trial']],
    [{ key: 'team', name: 'Team', prices: [{ amount: 20, interval: 'month' }] }, ['prices[0].currency', 'trial']],
    [{ key: 'pro', trial: true }, ['trialDays']],
  ])('%j → %j', (spec, expected) => {
    expect(fieldsOf(spec)).toEqual(expected);
  });

  it('a price added to a single-currency plan reuses that currency', () => {
    expect(planApplyWrite({ key: 'pro', prices: [{ amount: 100, interval: 'year' }] } as never, [PRO]).body.prices).toEqual([
      PRO.prices[0], { amount: 100, currency: 'USD', recurrenceInterval: 'year' },
    ]);
  });

  it('exits 1 through the command and writes nothing', async () => {
    const client = planClient([PRO]);
    mockClient.mockReturnValue(client);
    const res = await runCli('plan', 'apply', '--spec', JSON.stringify({ key: 'team', name: 'Team', prices: [{ amount: 20, interval: 'month' }] }));
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('DECISION_NEEDED');
    expect(client.plans.create).not.toHaveBeenCalled();
    expect(client.plans.update).not.toHaveBeenCalled();
  });
});

describe('bridge user invite asks which role', () => {
  it('without --role, offers the role keys, names the default, and invites nobody', async () => {
    const client = {
      roles: { list: jest.fn().mockResolvedValue([{ key: 'OWNER', isDefault: true }, { key: 'ADMIN', isDefault: false }]) },
      users: { invite: jest.fn() },
    };
    mockClient.mockReturnValue(client);
    const res = await runCli('user', 'invite', '--email', 'a@b.co', '--tenant-id', 't1');
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('DECISION_NEEDED');
    expect(res.error.fields).toEqual([expect.objectContaining({ name: 'role', type: 'enum', options: ['OWNER', 'ADMIN'], flag: '--role <key>' })]);
    expect(res.error.message).toContain('default role is OWNER');
    expect(client.users.invite).not.toHaveBeenCalled();
  });

  it('with --role, invites as before', async () => {
    const client = { roles: { list: jest.fn() }, users: { invite: jest.fn().mockResolvedValue({ id: 'u1' }) } };
    mockClient.mockReturnValue(client);
    const res = await runCli('user', 'invite', '--email', 'a@b.co', '--tenant-id', 't1', '--role', 'ADMIN');
    expect(res.exitCode).toBeUndefined();
    expect(client.users.invite).toHaveBeenCalledWith('t1', expect.objectContaining({ role: 'ADMIN' }));
  });
});
