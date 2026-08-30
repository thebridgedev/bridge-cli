/**
 * TBP-586 — Address resources by key instead of by opaque id.
 *
 * Every id-only write command now accepts a human-readable identifier
 * (`--key` for flags/roles, `--name` for tenants/tokens, `--email` for users)
 * resolved through the single shared helper in src/resolve.ts.
 *
 * The contract under test, per noun:
 *   - the key resolves to the right id and the command acts on it
 *   - the id path still works, unchanged, with no list() call
 *   - both options together  → INVALID_OPTIONS, nothing acts
 *   - neither option         → INVALID_OPTIONS naming both, nothing acts
 *   - unknown key            → <NOUN>_NOT_FOUND naming the list command
 *   - ambiguous key          → <NOUN>_AMBIGUOUS listing candidates, NOTHING ACTS
 *
 * The ambiguity case is the important one: `tenant delete --name Acme` with
 * two Acmes must refuse rather than pick, or the CLI deletes the wrong
 * workspace.
 *
 * Same commander-driving harness as role-command.test.ts.
 */

jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
    // flag.command.ts imports the canonical rule helpers at module load.
    OPERATORS: ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'lt', 'between', 'regex', 'exists', 'not_exists'],
    isOperator: (v: string) => true,
    validateRule: () => [],
    evaluateRule: () => ({ value: null, variantIndex: -1, matched: false, excludedByRollout: false }),
  }),
  { virtual: true },
);

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerFlagCommands } from '../commands/flag.command';
import { registerRoleCommands } from '../commands/role.command';
import { registerTenantCommands } from '../commands/tenant.command';
import { registerTokenCommands } from '../commands/token.command';
import { registerUserCommands } from '../commands/user.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

// ── fixtures ────────────────────────────────────────────────────────────────

const FLAGS = [
  { id: 'flag-id-1', key: 'beta-ui', state: 'off' },
  { id: 'flag-id-2', key: 'new-billing', state: 'on' },
];

const ROLES = [
  { id: 'role-id-1', key: 'ADMIN', name: 'Administrator', privileges: [], isDefault: false },
  { id: 'role-id-2', key: 'USER', name: 'User', privileges: [], isDefault: true },
];

const TENANTS = [
  { id: 'tenant-id-1', name: 'Acme', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'tenant-id-2', name: 'Globex', createdAt: '2026-02-02T00:00:00Z' },
];

/** Two workspaces genuinely sharing a name — the platform does not stop this. */
const TENANTS_DUPLICATE = [
  { id: 'tenant-id-1', name: 'Acme', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'tenant-id-3', name: 'Acme', createdAt: '2026-03-03T00:00:00Z' },
];

const TOKENS = [
  { id: 'token-id-1', name: 'ci', privileges: [] },
  { id: 'token-id-2', name: 'ci', privileges: [] },
  { id: 'token-id-3', name: 'local-dev', privileges: [] },
];

const USERS = [
  { id: 'user-id-1', email: 'ada@example.com', username: 'ada@example.com', fullName: 'Ada L' },
  { id: 'user-id-2', email: 'bob@example.com', username: 'bob@example.com', fullName: 'Bob B' },
];

interface MockClient {
  flags: { list: jest.Mock; update: jest.Mock; toggle: jest.Mock; delete: jest.Mock };
  roles: { list: jest.Mock; update: jest.Mock; delete: jest.Mock };
  tenants: { list: jest.Mock; get: jest.Mock; update: jest.Mock; delete: jest.Mock };
  tokens: { list: jest.Mock; revoke: jest.Mock };
  users: { list: jest.Mock; get: jest.Mock; update: jest.Mock; remove: jest.Mock };
}

function makeClient(overrides: Partial<Record<keyof MockClient, unknown>> = {}): MockClient {
  const client: MockClient = {
    flags: {
      list: jest.fn().mockResolvedValue(FLAGS),
      update: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      toggle: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    roles: {
      list: jest.fn().mockResolvedValue(ROLES),
      update: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    tenants: {
      list: jest.fn().mockResolvedValue(TENANTS),
      get: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      update: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    tokens: {
      list: jest.fn().mockResolvedValue(TOKENS),
      revoke: jest.fn().mockResolvedValue(undefined),
    },
    users: {
      list: jest.fn().mockResolvedValue(USERS),
      get: jest.fn().mockImplementation((_t: string, id: string) => Promise.resolve({ id })),
      update: jest.fn().mockImplementation((_t: string, id: string) => Promise.resolve({ id })),
      remove: jest.fn().mockResolvedValue(undefined),
    },
    ...(overrides as object),
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
  registerRoleCommands(program);
  registerTenantCommands(program);
  registerTokenCommands(program);
  registerUserCommands(program);

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

// ── flags ───────────────────────────────────────────────────────────────────

describe('bridge flag delete', () => {
  it('resolves --key to the flag id and deletes it', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'delete', '--key', 'new-billing');

    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({ success: true, data: { deleted: true, id: 'flag-id-2' } });
    expect(client.flags.delete).toHaveBeenCalledWith('flag-id-2');
  });

  it('still accepts --id, with no list() round trip', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'delete', '--id', 'flag-id-1');

    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({ success: true, data: { deleted: true, id: 'flag-id-1' } });
    expect(client.flags.delete).toHaveBeenCalledWith('flag-id-1');
    expect(client.flags.list).not.toHaveBeenCalled();
  });

  it('rejects --key and --id together without deleting anything', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'delete', '--key', 'beta-ui', '--id', 'flag-id-1');

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toBe('Pass either --id or --key, not both.');
    expect(client.flags.delete).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
  });

  it('rejects neither --key nor --id, naming both options', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'delete');

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toContain('--id <id>');
    expect(err.message).toContain('--key <key>');
    expect(client.flags.delete).not.toHaveBeenCalled();
  });

  it('reports an unknown key and points at the list command', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'delete', '--key', 'foo');

    const err = errorOf(res);
    expect(err.code).toBe('FLAG_NOT_FOUND');
    expect(err.message).toBe('Flag not found: foo. Run `bridge flag list` to see existing keys.');
    expect(client.flags.delete).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous key, lists the candidates, and deletes nothing', async () => {
    const client = makeClient({
      flags: {
        list: jest.fn().mockResolvedValue([
          { id: 'flag-id-1', key: 'beta-ui' },
          { id: 'flag-id-9', key: 'beta-ui' },
        ]),
        update: jest.fn(),
        toggle: jest.fn(),
        delete: jest.fn(),
      },
    });

    const res = await runCli('flag', 'delete', '--key', 'beta-ui');

    const err = errorOf(res);
    expect(err.code).toBe('FLAG_AMBIGUOUS');
    expect(err.message).toContain('matches 2 flags');
    expect(err.message).toContain('beta-ui (id flag-id-1)');
    expect(err.message).toContain('beta-ui (id flag-id-9)');
    expect(err.message).toContain('Nothing was changed.');
    expect(client.flags.delete).not.toHaveBeenCalled();
  });
});

describe('bridge flag toggle', () => {
  it('resolves --key and toggles', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'toggle', '--key', 'beta-ui', '--enabled', 'true');

    expect(res.stderr).toBe('');
    expect(client.flags.toggle).toHaveBeenCalledWith('flag-id-1', true);
  });

  it('still accepts --id', async () => {
    const client = makeClient();

    await runCli('flag', 'toggle', '--id', 'flag-id-2', '--enabled', 'false');

    expect(client.flags.toggle).toHaveBeenCalledWith('flag-id-2', false);
    expect(client.flags.list).not.toHaveBeenCalled();
  });

  it('rejects both options without toggling', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'toggle', '--key', 'beta-ui', '--id', 'x', '--enabled', 'true');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.flags.toggle).not.toHaveBeenCalled();
  });

  it('rejects neither option without toggling', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'toggle', '--enabled', 'true');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.flags.toggle).not.toHaveBeenCalled();
  });
});

describe('bridge flag update', () => {
  it('addresses by --key and does not treat the key as a rename', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'update', '--key', 'beta-ui', '--description', 'hi');

    expect(res.stderr).toBe('');
    expect(client.flags.update).toHaveBeenCalledWith('flag-id-1', { description: 'hi' });
  });

  it('renames via --new-key while addressing by --key', async () => {
    const client = makeClient();

    await runCli('flag', 'update', '--key', 'beta-ui', '--new-key', 'beta-ui-v2');

    expect(client.flags.update).toHaveBeenCalledWith('flag-id-1', { key: 'beta-ui-v2' });
  });

  it('keeps the legacy `--id X --key Y` rename working', async () => {
    const client = makeClient();

    await runCli('flag', 'update', '--id', 'flag-id-1', '--key', 'renamed');

    expect(client.flags.update).toHaveBeenCalledWith('flag-id-1', { key: 'renamed' });
    expect(client.flags.list).not.toHaveBeenCalled();
  });

  it('reports an unknown key without updating', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'update', '--key', 'nope', '--description', 'x');

    expect(errorOf(res).code).toBe('FLAG_NOT_FOUND');
    expect(client.flags.update).not.toHaveBeenCalled();
  });

  it('rejects neither --key nor --id', async () => {
    const client = makeClient();

    const res = await runCli('flag', 'update', '--description', 'x');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.flags.update).not.toHaveBeenCalled();
  });
});

describe('bridge flag schedule', () => {
  it('routes its positional key through the shared resolver', async () => {
    const client = makeClient();

    await runCli('flag', 'schedule', 'clear', 'new-billing');

    expect(client.flags.update).toHaveBeenCalledWith('flag-id-2', { schedule: null });
  });

  it('reports an unknown key with the shared not-found message', async () => {
    makeClient();

    const res = await runCli('flag', 'schedule', 'clear', 'ghost');

    const err = errorOf(res);
    expect(err.code).toBe('FLAG_NOT_FOUND');
    expect(err.message).toContain('bridge flag list');
  });
});

// ── roles ───────────────────────────────────────────────────────────────────

describe('bridge role update / delete', () => {
  it('resolves --key on update and never leaks the key into the payload', async () => {
    const client = makeClient();

    const res = await runCli('role', 'update', '--key', 'ADMIN', '--name', 'Admins');

    expect(res.stderr).toBe('');
    expect(client.roles.update).toHaveBeenCalledWith('role-id-1', { name: 'Admins' });
  });

  it('still accepts --id on update', async () => {
    const client = makeClient();

    await runCli('role', 'update', '--id', 'role-id-2', '--description', 'd');

    expect(client.roles.update).toHaveBeenCalledWith('role-id-2', { description: 'd' });
    expect(client.roles.list).not.toHaveBeenCalled();
  });

  it('resolves --key on delete', async () => {
    const client = makeClient();

    await runCli('role', 'delete', '--key', 'USER');

    expect(client.roles.delete).toHaveBeenCalledWith('role-id-2');
  });

  it('rejects both options on delete', async () => {
    const client = makeClient();

    const res = await runCli('role', 'delete', '--key', 'USER', '--id', 'role-id-2');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.roles.delete).not.toHaveBeenCalled();
  });

  it('rejects neither option on delete', async () => {
    const client = makeClient();

    const res = await runCli('role', 'delete');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.roles.delete).not.toHaveBeenCalled();
  });

  it('reports an unknown role key', async () => {
    const client = makeClient();

    const res = await runCli('role', 'delete', '--key', 'GHOST');

    const err = errorOf(res);
    expect(err.code).toBe('ROLE_NOT_FOUND');
    expect(err.message).toBe('Role not found: GHOST. Run `bridge role list` to see existing keys.');
    expect(client.roles.delete).not.toHaveBeenCalled();
  });
});

// ── tenants (no key field — addressed by name, which is NOT unique) ──────────

describe('bridge tenant get / update / delete', () => {
  it('resolves --name on get', async () => {
    const client = makeClient();

    const res = await runCli('tenant', 'get', '--name', 'Globex');

    expect(res.stderr).toBe('');
    expect(client.tenants.get).toHaveBeenCalledWith('tenant-id-2');
  });

  it('still accepts --id on get', async () => {
    const client = makeClient();

    await runCli('tenant', 'get', '--id', 'tenant-id-1');

    expect(client.tenants.get).toHaveBeenCalledWith('tenant-id-1');
    expect(client.tenants.list).not.toHaveBeenCalled();
  });

  it('resolves --name on update without renaming the tenant', async () => {
    const client = makeClient();

    await runCli('tenant', 'update', '--name', 'Acme', '--locale', 'sv');

    expect(client.tenants.update).toHaveBeenCalledWith('tenant-id-1', { locale: 'sv' });
  });

  it('renames via --new-name while addressing by --name', async () => {
    const client = makeClient();

    await runCli('tenant', 'update', '--name', 'Acme', '--new-name', 'Acme Corp');

    expect(client.tenants.update).toHaveBeenCalledWith('tenant-id-1', { name: 'Acme Corp' });
  });

  it('keeps the legacy `--id X --name Y` rename working', async () => {
    const client = makeClient();

    await runCli('tenant', 'update', '--id', 'tenant-id-1', '--name', 'Acme Corp Updated');

    expect(client.tenants.update).toHaveBeenCalledWith('tenant-id-1', { name: 'Acme Corp Updated' });
    expect(client.tenants.list).not.toHaveBeenCalled();
  });

  it('resolves --name on delete', async () => {
    const client = makeClient();

    await runCli('tenant', 'delete', '--name', 'Globex');

    expect(client.tenants.delete).toHaveBeenCalledWith('tenant-id-2');
  });

  it('rejects --name and --id together on delete', async () => {
    const client = makeClient();

    const res = await runCli('tenant', 'delete', '--name', 'Acme', '--id', 'tenant-id-1');

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toBe('Pass either --id or --name, not both.');
    expect(client.tenants.delete).not.toHaveBeenCalled();
  });

  it('rejects neither option on delete', async () => {
    const client = makeClient();

    const res = await runCli('tenant', 'delete');

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toContain('--name <name>');
    expect(client.tenants.delete).not.toHaveBeenCalled();
  });

  it('reports an unknown name', async () => {
    const client = makeClient();

    const res = await runCli('tenant', 'delete', '--name', 'Nope');

    const err = errorOf(res);
    expect(err.code).toBe('TENANT_NOT_FOUND');
    expect(err.message).toBe('Tenant not found: Nope. Run `bridge tenant list` to see existing names.');
    expect(client.tenants.delete).not.toHaveBeenCalled();
  });

  it('DELETES NOTHING when two tenants share the name, and lists both', async () => {
    const client = makeClient({
      tenants: {
        list: jest.fn().mockResolvedValue(TENANTS_DUPLICATE),
        get: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    });

    const res = await runCli('tenant', 'delete', '--name', 'Acme');

    const err = errorOf(res);
    expect(err.code).toBe('TENANT_AMBIGUOUS');
    expect(err.message).toContain('matches 2 tenants');
    expect(err.message).toContain('tenant-id-1');
    expect(err.message).toContain('tenant-id-3');
    expect(err.message).toContain('Re-run with --id <id> to pick one.');
    expect(client.tenants.delete).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous name on update too', async () => {
    const client = makeClient({
      tenants: {
        list: jest.fn().mockResolvedValue(TENANTS_DUPLICATE),
        get: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    });

    const res = await runCli('tenant', 'update', '--name', 'Acme', '--locale', 'sv');

    expect(errorOf(res).code).toBe('TENANT_AMBIGUOUS');
    expect(client.tenants.update).not.toHaveBeenCalled();
  });
});

// ── tokens (name is free text, not unique) ──────────────────────────────────

describe('bridge token revoke', () => {
  it('resolves a unique --name', async () => {
    const client = makeClient();

    const res = await runCli('token', 'revoke', '--name', 'local-dev');

    expect(res.stderr).toBe('');
    expect(client.tokens.revoke).toHaveBeenCalledWith('token-id-3');
  });

  it('still accepts --id', async () => {
    const client = makeClient();

    await runCli('token', 'revoke', '--id', 'token-id-1');

    expect(client.tokens.revoke).toHaveBeenCalledWith('token-id-1');
    expect(client.tokens.list).not.toHaveBeenCalled();
  });

  it('REVOKES NOTHING when two tokens share a name', async () => {
    const client = makeClient();

    const res = await runCli('token', 'revoke', '--name', 'ci');

    const err = errorOf(res);
    expect(err.code).toBe('TOKEN_AMBIGUOUS');
    expect(err.message).toContain('matches 2 tokens');
    expect(err.message).toContain('token-id-1');
    expect(err.message).toContain('token-id-2');
    expect(client.tokens.revoke).not.toHaveBeenCalled();
  });

  it('rejects both options', async () => {
    const client = makeClient();

    const res = await runCli('token', 'revoke', '--name', 'local-dev', '--id', 'token-id-3');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.tokens.revoke).not.toHaveBeenCalled();
  });

  it('rejects neither option', async () => {
    const client = makeClient();

    const res = await runCli('token', 'revoke');

    expect(errorOf(res).code).toBe('INVALID_OPTIONS');
    expect(client.tokens.revoke).not.toHaveBeenCalled();
  });

  it('reports an unknown name', async () => {
    makeClient();

    const res = await runCli('token', 'revoke', '--name', 'ghost');

    const err = errorOf(res);
    expect(err.code).toBe('TOKEN_NOT_FOUND');
    expect(err.message).toContain('bridge token list');
  });
});

// ── users (no key field — addressed by email, unique within a tenant) ───────

describe('bridge user get / update / remove', () => {
  it('resolves --email on get, scoped to the tenant', async () => {
    const client = makeClient();

    const res = await runCli('user', 'get', '--email', 'bob@example.com', '--tenant-id', 't1');

    expect(res.stderr).toBe('');
    expect(client.users.list).toHaveBeenCalledWith('t1');
    expect(client.users.get).toHaveBeenCalledWith('t1', 'user-id-2');
  });

  it('matches the email case-insensitively', async () => {
    const client = makeClient();

    await runCli('user', 'get', '--email', 'Bob@Example.COM', '--tenant-id', 't1');

    expect(client.users.get).toHaveBeenCalledWith('t1', 'user-id-2');
  });

  it('still accepts --user-id', async () => {
    const client = makeClient();

    await runCli('user', 'get', '--user-id', 'user-id-1', '--tenant-id', 't1');

    expect(client.users.get).toHaveBeenCalledWith('t1', 'user-id-1');
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it('resolves --email on update', async () => {
    const client = makeClient();

    await runCli('user', 'update', '--email', 'ada@example.com', '--role', 'ADMIN', '--tenant-id', 't1');

    expect(client.users.update).toHaveBeenCalledWith('t1', 'user-id-1', { role: 'ADMIN' });
  });

  it('resolves --email on remove', async () => {
    const client = makeClient();

    const res = await runCli('user', 'remove', '--email', 'ada@example.com', '--tenant-id', 't1');

    expect(JSON.parse(res.stdout)).toEqual({ success: true, data: { removed: true, userId: 'user-id-1' } });
    expect(client.users.remove).toHaveBeenCalledWith('t1', 'user-id-1');
  });

  it('rejects --email and --user-id together', async () => {
    const client = makeClient();

    const res = await runCli(
      'user', 'remove', '--email', 'ada@example.com', '--user-id', 'user-id-1', '--tenant-id', 't1',
    );

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toBe('Pass either --user-id or --email, not both.');
    expect(client.users.remove).not.toHaveBeenCalled();
  });

  it('rejects neither option, naming both', async () => {
    const client = makeClient();

    const res = await runCli('user', 'remove', '--tenant-id', 't1');

    const err = errorOf(res);
    expect(err.code).toBe('INVALID_OPTIONS');
    expect(err.message).toContain('--user-id <id>');
    expect(err.message).toContain('--email <email>');
    expect(client.users.remove).not.toHaveBeenCalled();
  });

  it('reports an unknown email', async () => {
    const client = makeClient();

    const res = await runCli('user', 'remove', '--email', 'ghost@example.com', '--tenant-id', 't1');

    const err = errorOf(res);
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.message).toBe(
      'User not found: ghost@example.com. Run `bridge user list` to see existing emails.',
    );
    expect(client.users.remove).not.toHaveBeenCalled();
  });

  it('REMOVES NOTHING when two users share an email', async () => {
    const client = makeClient({
      users: {
        list: jest.fn().mockResolvedValue([
          { id: 'user-id-1', email: 'dup@example.com', username: 'dup@example.com' },
          { id: 'user-id-7', email: 'dup@example.com', username: 'dup@example.com' },
        ]),
        get: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
      },
    });

    const res = await runCli('user', 'remove', '--email', 'dup@example.com', '--tenant-id', 't1');

    const err = errorOf(res);
    expect(err.code).toBe('USER_AMBIGUOUS');
    expect(err.message).toContain('matches 2 users');
    expect(client.users.remove).not.toHaveBeenCalled();
  });
});
