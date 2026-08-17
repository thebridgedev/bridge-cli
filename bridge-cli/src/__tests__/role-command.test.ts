/**
 * TBP-539 — Unit tests for `bridge role get <id-or-key>`.
 *
 * The management roles API only exposes list(), so `role get` is a
 * client-side lookup: by id first, then by key. Covers found (both ways) and
 * not-found (error names the known role keys). Same commander-driving harness
 * as app-redirect-uris.test.ts.
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
import { registerRoleCommands } from '../commands/role.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

const ROLES = [
  {
    id: '64a000000000000000000001',
    key: 'OWNER',
    name: 'Owner',
    isDefault: false,
    privileges: [{ id: 'p1', key: 'ALL' }],
  },
  {
    id: '64a000000000000000000002',
    key: 'USER',
    name: 'User',
    isDefault: true,
    privileges: [{ id: 'p2', key: 'READ' }],
  },
];

function makeClient(roles: unknown[] = ROLES): { roles: { list: jest.Mock } } {
  const client = { roles: { list: jest.fn().mockResolvedValue(roles) } };
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
  program.exitOverride();
  registerRoleCommands(program);

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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('bridge role get', () => {
  it('finds a role by key and outputs the full role (privileges included)', async () => {
    const client = makeClient();

    const res = await runCli('role', 'get', 'USER');

    expect(res.stderr).toBe('');
    expect(res.exitCode).toBeUndefined();
    const out = JSON.parse(res.stdout);
    expect(out).toEqual({ success: true, data: ROLES[1] });
    expect(client.roles.list).toHaveBeenCalledTimes(1);
  });

  it('finds a role by id', async () => {
    makeClient();

    const res = await runCli('role', 'get', '64a000000000000000000001');

    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({ success: true, data: ROLES[0] });
  });

  it('prefers an id match over a key match when both could apply', async () => {
    // Pathological but possible: one role's key equals another role's id.
    const idAsKey = [
      { id: 'aaa', key: 'bbb', name: 'First', isDefault: false, privileges: [] },
      { id: 'bbb', key: 'ccc', name: 'Second', isDefault: false, privileges: [] },
    ];
    makeClient(idAsKey);

    const res = await runCli('role', 'get', 'bbb');

    expect(JSON.parse(res.stdout).data.name).toBe('Second');
  });

  it('errors with a clear not-found message naming the known role keys', async () => {
    makeClient();

    const res = await runCli('role', 'get', 'NOPE');

    expect(res.stdout).toBe('');
    const out = JSON.parse(res.stderr);
    expect(out.success).toBe(false);
    expect(out.error.message).toContain('Role not found: NOPE');
    expect(out.error.message).toContain('OWNER');
    expect(out.error.message).toContain('USER');
    expect(res.exitCode).toBe(1);
  });

  it('reports "(none)" when the app has no roles at all', async () => {
    makeClient([]);

    const res = await runCli('role', 'get', 'ANY');

    const out = JSON.parse(res.stderr);
    expect(out.error.message).toContain('(none)');
    expect(res.exitCode).toBe(1);
  });
});
