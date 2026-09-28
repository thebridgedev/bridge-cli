/**
 * TBP-755 — the on/off features a plan includes, from the command line.
 *
 * Drives `bridge plan feature list|add|remove`, `plan create --features` and
 * `plan apply --spec` through commander with a mocked management client and
 * the REAL output module, so what is asserted is the request the CLI sends
 * and the JSON a caller reads:
 *  1. `feature add` writes the whole list with the new feature appended; other
 *     features are kept; the display name defaults to the key.
 *  2. `feature add` on an existing key renames it in place (upsert).
 *  3. `feature remove` writes the list without it; an unknown key is refused
 *     locally, naming the existing keys, with no API write.
 *  4. An invalid key is refused before any API call.
 *  5. `plan create --features` sends the parsed list; a bad key creates nothing.
 *  6. `plan apply` upserts features / removes named ones, keeps the rest, and
 *     leaves features out of the write when the spec does not mention them.
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
import { parseFeaturesOption, planApplyWrite, registerPlanCommands } from '../commands/plan.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

type MockClient = { plans: { list: jest.Mock; update: jest.Mock; create: jest.Mock } };

function makeClient(plans: unknown[]): MockClient {
  const client: MockClient = {
    plans: {
      list: jest.fn().mockResolvedValue(plans),
      update: jest.fn().mockImplementation((key: string, data: object) => Promise.resolve({ key, ...data })),
      create: jest.fn().mockImplementation((data: object) => Promise.resolve(data)),
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
  quotas: [],
  features: [
    { key: 'analytics', name: 'Analytics' },
    { key: 'sso', name: 'Single sign-on' },
  ],
};

/** A plan from a server that predates features. */
const FREE = { key: 'free', prices: [{ currency: 'USD', recurrenceInterval: 'month', amount: 0 }], quotas: [] };

beforeEach(() => jest.clearAllMocks());

describe('bridge plan feature list', () => {
  it('prints the features the plan includes', async () => {
    makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'list', 'pro');
    expect(res.exitCode).toBeUndefined();
    expect(JSON.parse(res.stdout).data).toEqual(PRO.features);
  });

  it('prints an empty list for a plan with no features field', async () => {
    makeClient([FREE]);
    const res = await runCli('plan', 'feature', 'list', 'free');
    expect(JSON.parse(res.stdout).data).toEqual([]);
  });
});

describe('bridge plan feature add', () => {
  it('appends the feature and keeps the others; the name defaults to the key', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'add', 'pro', 'exports');
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.update).toHaveBeenCalledTimes(1);
    expect(client.plans.update).toHaveBeenCalledWith('pro', {
      features: [...PRO.features, { key: 'exports', name: 'exports' }],
    });
    expect(JSON.parse(res.stdout).data.features).toContainEqual({ key: 'exports', name: 'exports' });
  });

  it('renames an existing feature in place with --name (upsert by key)', async () => {
    const client = makeClient([PRO]);
    await runCli('plan', 'feature', 'add', 'pro', 'sso', '--name', 'SAML SSO');
    expect(client.plans.update).toHaveBeenCalledWith('pro', {
      features: [
        { key: 'analytics', name: 'Analytics' },
        { key: 'sso', name: 'SAML SSO' },
      ],
    });
  });

  it('refuses an invalid key before any API call', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'add', 'pro', 'Advanced-Analytics');
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error).toEqual(
      expect.objectContaining({ code: 'INVALID_FEATURE', message: expect.stringMatching(/lower-case letters, digits and underscores/) }),
    );
    expect(client.plans.list).not.toHaveBeenCalled();
    expect(client.plans.update).not.toHaveBeenCalled();
  });

  it('fails on an unknown plan without writing', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'add', 'nope', 'exports');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/Plan not found: nope/);
    expect(client.plans.update).not.toHaveBeenCalled();
  });
});

describe('bridge plan feature remove', () => {
  it('writes the list without the feature', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'remove', 'pro', 'analytics');
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.update).toHaveBeenCalledWith('pro', { features: [{ key: 'sso', name: 'Single sign-on' }] });
  });

  it('refuses an unknown feature, naming the existing keys, with no write', async () => {
    const client = makeClient([PRO]);
    const res = await runCli('plan', 'feature', 'remove', 'pro', 'exports');
    expect(res.exitCode).toBe(1);
    const error = JSON.parse(res.stderr).error;
    expect(error.code).toBe('FEATURE_NOT_FOUND');
    expect(error.message).toMatch(/No feature "exports" on plan "pro"/);
    expect(error.message).toMatch(/analytics, sso/);
    expect(client.plans.update).not.toHaveBeenCalled();
  });
});

describe('bridge plan create --features', () => {
  it('sends the parsed features with the plan', async () => {
    const client = makeClient([]);
    const res = await runCli(
      'plan', 'create', '--key', 'team', '--name', 'Team', '--amount', '0', '--interval', 'month',
      '--features', 'analytics, sso:Single sign-on',
    );
    expect(res.exitCode).toBeUndefined();
    expect(client.plans.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'team',
        features: [
          { key: 'analytics', name: 'analytics' },
          { key: 'sso', name: 'Single sign-on' },
        ],
      }),
    );
  });

  it('sends no features field without --features', async () => {
    const client = makeClient([]);
    await runCli('plan', 'create', '--key', 'team', '--name', 'Team', '--amount', '0', '--interval', 'month');
    expect(client.plans.create.mock.calls[0][0]).not.toHaveProperty('features');
  });

  it('creates nothing when a feature key is invalid', async () => {
    const client = makeClient([]);
    const res = await runCli(
      'plan', 'create', '--key', 'team', '--name', 'Team', '--amount', '0', '--interval', 'month',
      '--features', 'analytics,Bad Key',
    );
    expect(res.exitCode).toBe(1);
    expect(client.plans.create).not.toHaveBeenCalled();
  });
});

describe('parseFeaturesOption', () => {
  it('keeps the last entry for a repeated key and skips empty entries', () => {
    expect(parseFeaturesOption('a:One,,a:Two,b')).toEqual([
      { key: 'a', name: 'Two' },
      { key: 'b', name: 'b' },
    ]);
  });
});

describe('plan apply features', () => {
  it('upserts named features, removes named ones and keeps the rest', () => {
    const write = planApplyWrite(
      { key: 'pro', features: [{ key: 'exports', name: 'Exports' }, { key: 'sso', name: 'SSO' }], removeFeatures: ['analytics'] },
      [PRO],
    );
    expect(write.created).toBe(false);
    expect(write.body.features).toEqual([
      { key: 'sso', name: 'SSO' },
      { key: 'exports', name: 'Exports' },
    ]);
  });

  it('leaves features out of the write when the spec does not mention them', () => {
    const write = planApplyWrite({ key: 'pro', name: 'Pro' }, [PRO]);
    expect(write.body).not.toHaveProperty('features');
  });

  it('refuses to remove a feature the plan does not have', () => {
    expect(() => planApplyWrite({ key: 'pro', removeFeatures: ['nope'] }, [PRO])).toThrow(/No feature "nope"/);
  });

  it('refuses an invalid feature key', () => {
    expect(() => planApplyWrite({ key: 'pro', features: [{ key: '1st' }] }, [PRO])).toThrow(/not valid/);
  });

  it('creates a new plan with its features', () => {
    const write = planApplyWrite(
      { key: 'team', name: 'Team', trial: false, prices: [{ amount: 0, interval: 'month' }], features: [{ key: 'analytics' }] },
      [],
    );
    expect(write.created).toBe(true);
    expect(write.body.features).toEqual([{ key: 'analytics', name: 'analytics' }]);
  });
});
