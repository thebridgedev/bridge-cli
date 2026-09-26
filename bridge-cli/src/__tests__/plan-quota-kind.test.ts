/**
 * TBP-699 — counter vs gauge quotas from the command line.
 *
 * Drives `bridge plan quota set|list` through commander with a mocked
 * management client and the REAL output module, so what is asserted is the
 * request the CLI sends and the JSON a caller reads:
 *  1. `quota set --kind gauge` writes the quota as a gauge.
 *  2. `quota set` without --kind keeps an existing gauge a gauge.
 *  3. A metered gauge and a counter `users` are refused locally, no API write.
 *  4. `quota list` with no key lists every metric once with its kind.
 *  5. `quota list <key>` resolves the kind of quotas stored without one.
 */

jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
  { virtual: true },
);

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { listMetrics, registerPlanCommands, validateQuotaEntry } from '../commands/plan.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

type MockClient = { plans: { list: jest.Mock; update: jest.Mock } };

function makeClient(plans: unknown[]): MockClient {
  const client: MockClient = {
    plans: {
      list: jest.fn().mockResolvedValue(plans),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  mockGetManagementClient.mockReturnValue(client);
  return client;
}

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
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
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerPlanCommands(program);
  try {
    await program.parseAsync(['node', 'bridge', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return { stdout, stderr, exitCode };
}

const PRO = {
  key: 'pro',
  prices: [{ currency: 'USD', recurrenceInterval: 'month', amount: 10 }],
  quotas: [
    { metric: 'projects', limit: 10, policy: 'hard', kind: 'gauge' },
    { metric: 'api_calls', limit: 1000, policy: 'hard' },
  ],
};

beforeEach(() => jest.clearAllMocks());

describe('bridge plan quota set --kind', () => {
  it('writes a new quota as a gauge', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'quota', 'set', 'pro', '--metric', 'tickets', '--limit', '50', '--policy', 'hard', '--kind', 'gauge');
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.update).toHaveBeenCalledWith('pro', {
      quotas: [...PRO.quotas, { metric: 'tickets', limit: 50, policy: 'hard', kind: 'gauge' }],
    });
  });

  it('keeps an existing gauge a gauge when --kind is omitted', async () => {
    const client = makeClient([PRO]);
    await runCli('plan', 'quota', 'set', 'pro', '--metric', 'projects', '--limit', '25', '--policy', 'hard');
    const sent = client.plans.update.mock.calls[0][1].quotas;
    expect(sent.find((q: { metric: string }) => q.metric === 'projects')).toEqual({
      metric: 'projects',
      limit: 25,
      policy: 'hard',
      kind: 'gauge',
    });
  });

  it('refuses a metered gauge without calling the API', async () => {
    const client = makeClient([PRO]);
    const res = await runCli(
      'plan', 'quota', 'set', 'pro', '--metric', 'projects', '--limit', '10',
      '--policy', 'metered', '--price-amount', '1',
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.exitCode).toBeDefined();
    expect(res.stderr).toContain('cannot be metered');
    expect(client.plans.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind and users as a counter', () => {
    expect(() => validateQuotaEntry({ metric: 'm', limit: 1, policy: 'hard', kind: 'sometimes' })).toThrow(/--kind must be one of/);
    expect(() => validateQuotaEntry({ metric: 'users', limit: 5, policy: 'hard', kind: 'counter' })).toThrow(/built-in seats gauge/);
    expect(validateQuotaEntry({ metric: 'users', limit: 5, policy: 'hard' })).toEqual({
      metric: 'users',
      limit: 5,
      policy: 'hard',
      kind: 'gauge',
    });
  });
});

describe('bridge plan quota list', () => {
  it('with no key lists every metric once, with its kind and the plans that limit it', async () => {
    makeClient([
      PRO,
      { key: 'free', prices: [], quotas: [{ metric: 'projects', limit: 2, policy: 'hard', kind: 'gauge' }] },
      { key: 'legacy', prices: [] },
    ]);
    const res = await runCli('plan', 'quota', 'list');
    expect(res.stderr).toBe('');
    const { data } = JSON.parse(res.stdout);
    expect(data.map((m: { metric: string }) => m.metric)).toEqual(['api_calls', 'projects']);
    expect(data[0]).toMatchObject({ metric: 'api_calls', kind: 'counter' });
    expect(data[1]).toEqual({
      metric: 'projects',
      kind: 'gauge',
      plans: [
        { planKey: 'pro', kind: 'gauge', limit: 10, policy: 'hard' },
        { planKey: 'free', kind: 'gauge', limit: 2, policy: 'hard' },
      ],
    });
  });

  it('with a key resolves the kind of quotas stored without one', async () => {
    makeClient([PRO]);
    const res = await runCli('plan', 'quota', 'list', 'pro');
    const { data } = JSON.parse(res.stdout);
    expect(data).toEqual([
      { metric: 'projects', limit: 10, policy: 'hard', kind: 'gauge' },
      { metric: 'api_calls', limit: 1000, policy: 'hard', kind: 'counter' },
    ]);
  });

  it('marks a metric whose plans disagree on its kind as mixed', () => {
    const metrics = listMetrics([
      { key: 'a', quotas: [{ metric: 'x', limit: 1, policy: 'hard', kind: 'gauge' }] },
      { key: 'b', quotas: [{ metric: 'x', limit: 1, policy: 'hard' }] },
    ]);
    expect(metrics[0].kind).toBe('mixed');
  });
});
