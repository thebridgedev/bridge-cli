/**
 * TBP-592 — `--privileges` takes keys, the API stores ids.
 *
 * `bridge role create --privileges "AUTHENTICATED,CASE_READ"` used to send
 * those keys straight through. `POST /account/role` types `privileges` as
 * `Types.ObjectId[]` and resolves them with `findByIdsAndApp`, so every key
 * resolved to nothing, the array arrived empty, and the model's pre-save hook
 * answered "A role needs at least one privilege" — an error that reads as
 * "you passed none" when the truth is "the ones you passed were dropped".
 *
 * The contract under test:
 *   - keys resolve to ids before the request goes out
 *   - ids still pass through, and may be mixed with keys
 *   - an unknown identifier FAILS, naming the offenders, and nothing is created
 *   - duplicates collapse
 *   - `role update` only touches privileges when --privileges was passed
 *
 * The failure case is the important one. Silently dropping one privilege out of
 * ten yields a role that looks right and under-permits — a security-shaped bug
 * that surfaces much later, and the reason the old behaviour cost so much time.
 */

jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
);

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
}));

import { Command } from 'commander';
import { getManagementClient } from '../config';
import { registerRoleCommands } from '../commands/role.command';

const mockGetManagementClient = getManagementClient as jest.Mock;

const PRIVILEGES = [
  { id: 'priv-id-auth', key: 'AUTHENTICATED' },
  { id: 'priv-id-read', key: 'CASE_READ' },
  { id: 'priv-id-write', key: 'CASE_WRITE' },
];

const ROLES = [{ id: 'role-id-1', key: 'MANAGER', name: 'Manager', privileges: [], isDefault: false }];

function makeClient() {
  return {
    roles: {
      list: jest.fn().mockResolvedValue(ROLES),
      listPrivileges: jest.fn().mockResolvedValue(PRIVILEGES),
      create: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
      update: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
      delete: jest.fn().mockResolvedValue(undefined),
    },
  };
}

/** Drive the real commander tree the way a user's argv would. */
async function run(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerRoleCommands(program);
  await program.parseAsync(['node', 'bridge', ...argv]);
}

describe('TBP-592 — privilege keys resolve to ids', () => {
  let client: ReturnType<typeof makeClient>;
  let exitSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    client = makeClient();
    mockGetManagementClient.mockReturnValue(client);
    // outputError calls process.exit; stop it unwinding the test runner.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // output.ts writes through process.stdout/stderr directly, not console.
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    outSpy.mockRestore();
    jest.clearAllMocks();
  });

  /** Everything the CLI printed, whichever stream it chose. */
  const printed = () =>
    [...outSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0] ?? '')).join('\n');

  it('sends ids, not keys, when creating a role', async () => {
    await run([
      'role', 'create',
      '--name', 'Manager',
      '--key', 'MANAGER',
      '--privileges', 'AUTHENTICATED,CASE_READ,CASE_WRITE',
    ]);

    expect(client.roles.create).toHaveBeenCalledTimes(1);
    expect(client.roles.create.mock.calls[0][0]).toMatchObject({
      name: 'Manager',
      key: 'MANAGER',
      privileges: ['priv-id-auth', 'priv-id-read', 'priv-id-write'],
    });
  });

  it('still accepts raw ids, and a mix of ids and keys', async () => {
    await run([
      'role', 'create',
      '--name', 'Mixed',
      '--key', 'MIXED',
      '--privileges', 'priv-id-auth,CASE_READ',
    ]);

    expect(client.roles.create.mock.calls[0][0].privileges).toEqual([
      'priv-id-auth',
      'priv-id-read',
    ]);
  });

  it('collapses a privilege named twice under both spellings', async () => {
    await run([
      'role', 'create',
      '--name', 'Dup',
      '--key', 'DUP',
      '--privileges', 'CASE_READ,priv-id-read',
    ]);

    expect(client.roles.create.mock.calls[0][0].privileges).toEqual(['priv-id-read']);
  });

  it('refuses an unknown privilege, names it, and creates nothing', async () => {
    await run([
      'role', 'create',
      '--name', 'Bad',
      '--key', 'BAD',
      '--privileges', 'AUTHENTICATED,NOPE_NOT_REAL',
    ]);

    // The whole point: no partial role with the survivors.
    expect(client.roles.create).not.toHaveBeenCalled();

    const output = printed();
    expect(output).toContain('NOPE_NOT_REAL');
    // And it must not blame the user for passing nothing.
    expect(output).not.toContain('at least one privilege');
  });

  it('lists the available keys so the fix is obvious from the error', async () => {
    await run([
      'role', 'create',
      '--name', 'Bad',
      '--key', 'BAD',
      '--privileges', 'CASE_DELETE',
    ]);

    const output = printed();
    expect(output).toContain('AUTHENTICATED');
    expect(output).toContain('CASE_READ');
  });

  it('resolves keys on update too', async () => {
    await run(['role', 'update', '--key', 'MANAGER', '--privileges', 'CASE_WRITE']);

    expect(client.roles.update).toHaveBeenCalledTimes(1);
    const [, payload] = client.roles.update.mock.calls[0];
    expect(payload.privileges).toEqual(['priv-id-write']);
  });

  it('leaves privileges untouched when --privileges is not passed', async () => {
    // A rename must not blank the role's privileges as a side effect.
    await run(['role', 'update', '--key', 'MANAGER', '--name', 'Renamed']);

    const [, payload] = client.roles.update.mock.calls[0];
    expect(payload).not.toHaveProperty('privileges');
    expect(payload.name).toBe('Renamed');
    expect(client.roles.listPrivileges).not.toHaveBeenCalled();
  });

  it('does not call the privileges endpoint when none are supplied', async () => {
    await run(['role', 'create', '--name', 'Empty', '--key', 'EMPTY']);

    expect(client.roles.listPrivileges).not.toHaveBeenCalled();
    expect(client.roles.create.mock.calls[0][0].privileges).toEqual([]);
  });
});
