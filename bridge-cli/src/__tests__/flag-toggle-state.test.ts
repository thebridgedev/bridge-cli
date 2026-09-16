/**
 * TBP-548 — `bridge flag toggle` must move the FF 2.0 `state`, not the FF 1.0
 * `enabled` boolean.
 *
 * The old command PUT `{ enabled }`. Feature Flags 2.0 dropped that field from
 * the flag document (the model carries `state` only) and the server's write
 * DTO strips keys it does not declare, so the body arrived as `{}`: HTTP 200,
 * flag untouched, CLI printing `success: true`. A command that reports success
 * while changing nothing is worse than one that errors.
 *
 * The mapping and the two refusals below mirror the MCP `toggle_feature_flag`
 * tool, fixed under TBP-587, so both surfaces over `PUT /v1/admin/flags/flag/:id`
 * behave identically:
 *
 *   --enabled true   → state "on"
 *   --enabled false  → state "off"
 *   on-with-rule + --enabled true  → refused (widening, not toggling)
 *   write did not land             → loud failure, not silent success
 *
 * Every assertion here names the exact request body. Asserting merely "a write
 * happened" would have passed against the broken `{ enabled }` payload, which
 * is precisely how this shipped.
 */

jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
    // flag.command.ts imports the canonical rule helpers at module load.
    OPERATORS: ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'lt', 'between', 'regex', 'exists', 'not_exists'],
    isOperator: () => true,
    validateRule: () => [],
    evaluateRule: () => ({ value: null, variantIndex: -1, matched: false, excludedByRollout: false }),
  }),
);

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerFlagCommands } from '../commands/flag.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

interface Flag {
  id: string;
  key: string;
  state?: string;
  rule?: unknown;
  enabled?: boolean;
  segments?: unknown[];
}

/**
 * One flag in the workspace, and an `update` that echoes what it was sent —
 * the way the API answers a write, and what the command's read-back check
 * inspects. `update` can be overridden to model a server that accepts the
 * call without applying it.
 */
function mockClient(flag: Flag, update?: jest.Mock) {
  const client = {
    flags: {
      list: jest.fn().mockResolvedValue([flag]),
      update:
        update ??
        jest.fn().mockImplementation((id: string, data: object) => Promise.resolve({ ...flag, id, ...data })),
      toggle: jest.fn(),
      delete: jest.fn(),
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
  registerFlagCommands(program);

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

function errorOf(res: CliResult): { code: string; message: string } {
  expect(res.stdout).toBe('');
  return JSON.parse(res.stderr).error;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('bridge flag toggle writes state, not the legacy enabled boolean (TBP-548)', () => {
  it('--enabled true sends exactly { state: "on" }', async () => {
    const client = mockClient({ id: 'f1', key: 'beta', state: 'off' });

    const res = await runCli('flag', 'toggle', '--key', 'beta', '--enabled', 'true');

    expect(res.stderr).toBe('');
    expect(client.flags.update).toHaveBeenCalledTimes(1);
    const [id, body] = client.flags.update.mock.calls[0];
    expect(id).toBe('f1');
    expect(body).toEqual({ state: 'on' });
    expect(body).not.toHaveProperty('enabled');
  });

  it('--enabled false sends exactly { state: "off" }', async () => {
    const client = mockClient({ id: 'f1', key: 'beta', state: 'on' });

    const res = await runCli('flag', 'toggle', '--key', 'beta', '--enabled', 'false');

    expect(res.stderr).toBe('');
    const [, body] = client.flags.update.mock.calls[0];
    expect(body).toEqual({ state: 'off' });
    expect(body).not.toHaveProperty('enabled');
  });

  it('never routes through the legacy flags.toggle() SDK method', async () => {
    const client = mockClient({ id: 'f1', key: 'beta', state: 'off' });

    await runCli('flag', 'toggle', '--key', 'beta', '--enabled', 'true');

    expect(client.flags.toggle).not.toHaveBeenCalled();
  });

  it('reports the flag back with the new state on stdout', async () => {
    mockClient({ id: 'f1', key: 'beta', state: 'off' });

    const res = await runCli('flag', 'toggle', '--key', 'beta', '--enabled', 'true');

    expect(JSON.parse(res.stdout)).toEqual({
      success: true,
      data: { id: 'f1', key: 'beta', state: 'on' },
    });
  });
});

describe('bridge flag toggle and rule-targeted flags (TBP-548)', () => {
  it('refuses to turn ON an on-with-rule flag — that widens it to everyone', async () => {
    const client = mockClient({ id: 'f1', key: 'holo', state: 'on-with-rule', rule: { branches: [] } });

    const res = await runCli('flag', 'toggle', '--key', 'holo', '--enabled', 'true');

    const err = errorOf(res);
    expect(err.code).toBe('FLAG_HAS_TARGETING');
    expect(err.message).toContain('bridge flag update');
    expect(err.message).toContain('--state on');
    expect(client.flags.update).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
  });

  it('still turns an on-with-rule flag OFF, preserving the rule', async () => {
    const client = mockClient({ id: 'f1', key: 'holo', state: 'on-with-rule', rule: { branches: [] } });

    const res = await runCli('flag', 'toggle', '--key', 'holo', '--enabled', 'false');

    expect(res.stderr).toBe('');
    const [, body] = client.flags.update.mock.calls[0];
    // Only `state` is sent: the rule document is left exactly as it was, so
    // the flag can be put back with `flag update --state on-with-rule`.
    expect(body).toEqual({ state: 'off' });
  });
});

describe('bridge flag toggle verifies the write landed (TBP-548)', () => {
  it('FAILS LOUDLY when the server accepts the call but the flag does not move', async () => {
    // Exactly the original defect: 200 OK, flag unchanged. Previously this
    // printed success and the user believed the flag had flipped.
    const stuck = jest.fn().mockResolvedValue({ id: 'f1', key: 'beta', state: 'off' });
    const client = mockClient({ id: 'f1', key: 'beta', state: 'off' }, stuck);

    const res = await runCli('flag', 'toggle', '--key', 'beta', '--enabled', 'true');

    const err = errorOf(res);
    expect(err.code).toBe('TOGGLE_NOT_APPLIED');
    expect(err.message).toContain('did NOT take effect');
    expect(err.message).toContain("state='off'");
    expect(client.flags.update).toHaveBeenCalledTimes(1);
    expect(res.exitCode).toBe(1);
  });
});

describe('bridge flag toggle against a pre-2.0 API shape (TBP-548)', () => {
  // An API that has not rolled out the 2.0 fields returns `enabled`/`segments`
  // only. `deriveState` maps that onto a state so the rule guard still fires,
  // and the write is still expressed in 2.0 terms.
  it('derives on-with-rule from legacy segments and refuses to widen it', async () => {
    const client = mockClient({ id: 'f1', key: 'legacy', enabled: true, segments: [{ id: 's1' }] });

    const res = await runCli('flag', 'toggle', '--key', 'legacy', '--enabled', 'true');

    expect(errorOf(res).code).toBe('FLAG_HAS_TARGETING');
    expect(client.flags.update).not.toHaveBeenCalled();
  });

  it('turns a legacy enabled flag off with a state write', async () => {
    const client = mockClient({ id: 'f1', key: 'legacy', enabled: true, segments: [] });

    await runCli('flag', 'toggle', '--key', 'legacy', '--enabled', 'false');

    const [, body] = client.flags.update.mock.calls[0];
    expect(body).toEqual({ state: 'off' });
  });
});
