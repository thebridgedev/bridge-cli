/**
 * The CLI never makes an app key behind a command: no `POST /apps/{appId}/keys`
 * is sent by any command except `key create`, whether you are signed in or
 * `BRIDGE_APP_KEY` is set. Every command that used to run with a one-day key
 * now calls the operator route with the sign-in (or, with the key set, the key
 * route with that key).
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  await cli.run(['app', 'use', appId]);
  fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' }, [{ id: 'mem-1', user: { email: 'ann@customer.example' }, role: 'MEMBER' }]);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

const commands: { args: string[]; stdin?: string }[] = [
  { args: ['role', 'create', 'editor', '--name', 'Editor'] },
  { args: ['role', 'list'] },
  { args: ['role', 'update', 'editor', '--name', 'Editors'] },
  { args: ['role', 'delete', 'editor'] },
  { args: ['privilege', 'create', 'POSTS_WRITE'] },
  { args: ['privilege', 'list'] },
  { args: ['privilege', 'update', 'POSTS_WRITE', '--description', 'Write'] },
  { args: ['privilege', 'delete', 'POSTS_WRITE'] },
  { args: ['workspace', 'list'] },
  { args: ['member', 'list', '--workspace', 'cust-1'] },
  { args: ['member', 'get', 'mem-1', '--workspace', 'cust-1'] },
  { args: ['member', 'update', 'mem-1', '--workspace', 'cust-1', '--role', 'ADMIN'] },
  { args: ['member', 'remove', 'mem-1', '--workspace', 'cust-1', '--yes'] },
  { args: ['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'MEMBER'] },
  { args: ['invite', 'list', '--workspace', 'cust-1'] },
  { args: ['invite', 'send', 'bob@example.com', '--role', 'MEMBER'] },
  { args: ['invite', 'list'] },
  { args: ['stripe', 'connect', '--secret-key-stdin'], stdin: 'sk_test_abc' },
  { args: ['stripe', 'status'] },
  { args: ['stripe', 'disconnect', '--yes'] },
  { args: ['plan', 'list'] },
  { args: ['flag', 'list'] },
  { args: ['key', 'list'] },
];

it('signed in: no command makes a key, and each reaches Bridge with the sign-in', async () => {
  for (const { args, stdin } of commands) {
    const done = await cli.run(args, stdin === undefined ? {} : { stdin });
    expect({ args, errors: done.errors }).toEqual({ args, errors: [] });
  }
  expect(fake.keyMints()).toEqual([]);
  const calls = fake.requests.filter((r) => r.path.startsWith('/v2/') && !r.path.includes('/sign-in') && !r.path.endsWith('/token'));
  expect(calls.length).toBeGreaterThan(commands.length);
  expect(calls.filter((r) => r.headers['x-api-key'] !== undefined)).toEqual([]);
  expect(calls.filter((r) => r.headers['authorization'] === undefined)).toEqual([]);
});

it('`role delete` and `invite send` call the operator routes and no key route', async () => {
  fake.roles(appId).push({ id: 'role-1', key: 'editor', name: 'Editor', privileges: [] });
  await cli.run(['role', 'delete', 'editor']);
  await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'MEMBER']);
  expect(fake.requests.filter((r) => r.method === 'POST' && /\/apps\/[^/]+\/keys$/.test(r.path))).toEqual([]);
  expect(fake.requests.filter((r) => r.method === 'DELETE' && r.path === `/v2/accounts/apps/${appId}/roles/role-1`)).toHaveLength(1);
  expect(fake.requests.filter((r) => r.method === 'POST' && r.path === `/v2/accounts/apps/${appId}/workspaces/cust-1/invites`)).toHaveLength(1);
  expect(fake.invites(`${appId}/cust-1`)).toEqual([expect.objectContaining({ email: 'carol@customer.example', state: 'open' })]);
});

it('with BRIDGE_APP_KEY set: no key is made, the key routes are used and the sign-in is not', async () => {
  const env = { BRIDGE_APP_KEY: fake.addKey(appId, ['USER_READ', 'USER_WRITE', 'ROLE_DELETE', 'apps.settings:manage', 'billing.connection:manage']) };
  const before = fake.requests.length;
  for (const { args, stdin } of commands.filter((c) => ['role', 'privilege', 'workspace', 'member', 'stripe'].includes(c.args[0] as string) && c.args[1] !== 'status' && c.args[1] !== 'disconnect')) {
    const done = await cli.run(args, { env, ...(stdin === undefined ? {} : { stdin }) });
    expect({ args, errors: done.errors }).toEqual({ args, errors: [] });
  }
  const calls = fake.requests.slice(before).filter((r) => r.path.startsWith('/v2/'));
  expect(calls.length).toBeGreaterThan(8);
  expect(fake.keyMints()).toEqual([]);
  expect(calls.every((r) => r.headers['x-api-key'] === env.BRIDGE_APP_KEY && r.headers['authorization'] === undefined)).toBe(true);
  expect(calls.some((r) => r.path.includes('/apps/'))).toBe(false);
});
