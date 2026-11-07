/**
 * Roles, privileges, workspaces and members: version 2 offers them to the
 * app's own server only, so each command runs with an app key: BRIDGE_APP_KEY,
 * or a one-day key holding only what the command needs, revoked after.
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const last = (method: string, part: string) => fake.requests.filter((r) => r.method === method && r.path.includes(part)).pop();
const temporaryKeys = () => fake.requests.filter((r) => r.method === 'POST' && r.path === `/v2/identity-access/apps/${appId}/keys`).map((r) => r.body);

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  await cli.run(['app', 'use', appId]);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  expect([...fake.keys.values()].filter((k) => k.name === 'bridge-cli (temporary)' && !k.revoked)).toEqual([]);
  cli.cleanup();
});

describe('role and privilege', () => {
  it('create, list, update by key, delete with a key that holds ROLE_DELETE', async () => {
    const made = await cli.run(['role', 'create', 'editor', '--name', 'Editor', '--privilege', 'POSTS_WRITE', '--privilege', 'POSTS_READ', '--default']);
    expect(made.errors).toEqual([]);
    expect(last('POST', '/v2/accounts/roles')?.body).toEqual({ key: 'editor', name: 'Editor', privileges: ['POSTS_WRITE', 'POSTS_READ'], isDefault: true });
    expect(last('POST', '/v2/accounts/roles')?.headers['x-api-key']).toMatch(new RegExp(`^bk\\.${appId}\\.`));
    expect((await cli.run(['role', 'list'])).data).toEqual([expect.objectContaining({ key: 'editor' })]);

    await cli.run(['role', 'update', 'editor', '--privilege', 'POSTS_READ']);
    expect(last('PATCH', '/v2/accounts/roles/')?.body).toEqual({ privileges: ['POSTS_READ'] });

    expect((await cli.run(['role', 'delete', 'editor'])).errors).toEqual([]);
    expect(temporaryKeys().pop()).toEqual({ name: 'bridge-cli (temporary)', privileges: ['ROLE_DELETE'], expiresInDays: 1 });
    expect(fake.roles(appId)).toEqual([]);
    expect((await cli.run(['role', 'delete', 'nobody'])).error).toMatchObject({ code: 'not-found' });
  });

  it('privilege create / update / delete', async () => {
    await cli.run(['privilege', 'create', 'POSTS_WRITE', '--description', 'Write posts']);
    expect(last('POST', '/v2/accounts/privileges')?.body).toEqual({ key: 'POSTS_WRITE', description: 'Write posts' });
    await cli.run(['privilege', 'update', 'POSTS_WRITE', '--new-key', 'POSTS_EDIT']);
    expect(last('PATCH', '/v2/accounts/privileges/')?.body).toEqual({ key: 'POSTS_EDIT' });
    expect((await cli.run(['privilege', 'delete', 'POSTS_EDIT'])).errors).toEqual([]);
  });

  it('uses BRIDGE_APP_KEY when it is set', async () => {
    const key = (await cli.run(['key', 'create', '--name', 'server', '--privilege', 'ROLE_DELETE'])).data.key as string;
    const before = temporaryKeys().length;
    await cli.run(['role', 'list'], { env: { BRIDGE_APP_KEY: key } });
    expect(temporaryKeys().length).toBe(before);
    expect(last('GET', '/v2/accounts/roles')?.headers['x-api-key']).toBe(key);
  });
});

describe('workspace and member', () => {
  beforeEach(() => {
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' }, [{ id: 'mem-1', user: { email: 'ann@customer.example' }, role: 'MEMBER' }]);
  });

  it('workspace list', async () => {
    expect((await cli.run(['workspace', 'list'])).data).toEqual([{ id: 'cust-1', name: 'Customer One' }]);
  });

  it('member list / get / update / remove send the workspace in Bridge-Workspace, with a key that holds the privilege', async () => {
    const list = await cli.run(['member', 'list', '--workspace', 'cust-1']);
    expect(list.data).toEqual([expect.objectContaining({ id: 'mem-1' })]);
    expect(last('GET', '/v2/accounts/members')?.headers['bridge-workspace']).toBe('cust-1');
    expect(temporaryKeys().pop()).toMatchObject({ privileges: ['USER_READ'] });

    expect((await cli.run(['member', 'get', 'mem-1', '--workspace', 'cust-1'])).data.user.email).toBe('ann@customer.example');
    await cli.run(['member', 'update', 'mem-1', '--workspace', 'cust-1', '--role', 'ADMIN']);
    expect(last('PATCH', '/v2/accounts/members/mem-1')?.body).toEqual({ role: 'ADMIN' });
    expect(temporaryKeys().pop()).toMatchObject({ privileges: ['USER_WRITE'] });
    expect((await cli.run(['member', 'remove', 'mem-1', '--workspace', 'cust-1', '--yes'])).data).toEqual({ deleted: 'mem-1' });
  });

  it('member commands need --workspace', async () => {
    expect((await cli.run(['member', 'list'])).error).toMatchObject({ code: 'usage' });
  });
});
