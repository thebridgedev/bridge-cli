/**
 * Roles, privileges, workspaces and members run with the developer's sign-in
 * on the operator routes (`/apps/{appId}/…`). With BRIDGE_APP_KEY set, they
 * run as the app's server on the key routes. No command makes an app key.
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const last = (method: string, part: string) => fake.requests.filter((r) => r.method === method && r.path.includes(part)).pop();

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
  // No command makes an app key.
  expect(fake.keyMints()).toEqual([]);
  cli.cleanup();
});

const OPERATOR = () => `/v2/accounts/apps/${appId}`;

describe('role and privilege', () => {
  it('create, list, update by key, delete: on the operator routes with your sign-in', async () => {
    const made = await cli.run(['role', 'create', 'editor', '--name', 'Editor', '--privilege', 'POSTS_WRITE', '--privilege', 'POSTS_READ', '--default']);
    expect(made.errors).toEqual([]);
    const create = last('POST', `${OPERATOR()}/roles`)!;
    expect(create.body).toEqual({ key: 'editor', name: 'Editor', privileges: ['POSTS_WRITE', 'POSTS_READ'], isDefault: true });
    expect(create.headers['authorization']).toMatch(/^Bearer /);
    expect(create.headers['x-api-key']).toBeUndefined();
    expect((await cli.run(['role', 'list'])).data).toEqual([expect.objectContaining({ key: 'editor' })]);

    await cli.run(['role', 'update', 'editor', '--privilege', 'POSTS_READ']);
    expect(last('PATCH', `${OPERATOR()}/roles/`)?.body).toEqual({ privileges: ['POSTS_READ'] });

    expect((await cli.run(['role', 'delete', 'editor'])).errors).toEqual([]);
    expect(last('DELETE', `${OPERATOR()}/roles/`)?.headers['authorization']).toMatch(/^Bearer /);
    expect(fake.roles(appId)).toEqual([]);
    expect((await cli.run(['role', 'delete', 'nobody'])).error).toMatchObject({ code: 'not-found' });
    expect(fake.keyMints()).toEqual([]);
  });

  it('privilege create / update / delete', async () => {
    await cli.run(['privilege', 'create', 'POSTS_WRITE', '--description', 'Write posts']);
    expect(last('POST', `${OPERATOR()}/privileges`)?.body).toEqual({ key: 'POSTS_WRITE', description: 'Write posts' });
    await cli.run(['privilege', 'update', 'POSTS_WRITE', '--new-key', 'POSTS_EDIT']);
    expect(last('PATCH', `${OPERATOR()}/privileges/`)?.body).toEqual({ key: 'POSTS_EDIT' });
    expect((await cli.run(['privilege', 'delete', 'POSTS_EDIT'])).errors).toEqual([]);
    expect(last('DELETE', `${OPERATOR()}/privileges/`)?.headers['authorization']).toMatch(/^Bearer /);
  });

  it('with BRIDGE_APP_KEY set, the key routes are used as the app\'s server, with that key and no sign-in', async () => {
    const key = fake.addKey(appId, ['roles:delete', 'apps.settings:manage']);
    await cli.run(['role', 'create', 'editor', '--name', 'Editor'], { env: { BRIDGE_APP_KEY: key } });
    const created = last('POST', '/v2/accounts/roles')!;
    expect(created.headers['x-api-key']).toBe(key);
    expect(created.headers['authorization']).toBeUndefined();
    expect((await cli.run(['role', 'list'], { env: { BRIDGE_APP_KEY: key } })).data).toEqual([expect.objectContaining({ key: 'editor' })]);
    expect((await cli.run(['role', 'delete', 'editor'], { env: { BRIDGE_APP_KEY: key } })).errors).toEqual([]);
    expect((await cli.run(['privilege', 'list'], { env: { BRIDGE_APP_KEY: key } })).errors).toEqual([]);
    expect(fake.requests.some((r) => r.path.startsWith(`${OPERATOR()}/`))).toBe(false);
    expect(fake.keyMints()).toEqual([]);
  });

  it('refuses a BRIDGE_APP_KEY of another app before calling', async () => {
    const before = fake.requests.length;
    const done = await cli.run(['role', 'list'], { env: { BRIDGE_APP_KEY: 'bk.other-app.k1.s3cret' } });
    expect(done.error).toMatchObject({ code: 'misconfigured' });
    expect(fake.requests.slice(before).filter((r) => r.path.includes('/roles'))).toEqual([]);
  });
});

describe('workspace and member', () => {
  beforeEach(() => {
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' }, [{ id: 'mem-1', user: { email: 'ann@customer.example' }, role: 'MEMBER' }]);
  });

  it('workspace list', async () => {
    expect((await cli.run(['workspace', 'list'])).data).toEqual([{ id: 'cust-1', name: 'Customer One' }]);
    expect(last('GET', `${OPERATOR()}/workspaces`)?.headers['authorization']).toMatch(/^Bearer /);
  });

  it('member list / get / update / remove name the workspace in the path, with your sign-in', async () => {
    const base = `${OPERATOR()}/workspaces/cust-1/members`;
    const list = await cli.run(['member', 'list', '--workspace', 'cust-1']);
    expect(list.data).toEqual([expect.objectContaining({ id: 'mem-1' })]);
    expect(last('GET', base)?.headers['authorization']).toMatch(/^Bearer /);
    expect(last('GET', base)?.headers['bridge-workspace']).toBeUndefined();

    expect((await cli.run(['member', 'get', 'mem-1', '--workspace', 'cust-1'])).data.user.email).toBe('ann@customer.example');
    await cli.run(['member', 'update', 'mem-1', '--workspace', 'cust-1', '--role', 'ADMIN']);
    expect(last('PATCH', `${base}/mem-1`)?.body).toEqual({ role: 'ADMIN' });
    expect((await cli.run(['member', 'remove', 'mem-1', '--workspace', 'cust-1', '--yes'])).data).toEqual({ deleted: 'mem-1' });
    expect(last('DELETE', `${base}/mem-1`)?.headers['authorization']).toMatch(/^Bearer /);
    expect(fake.keyMints()).toEqual([]);
  });

  it('with BRIDGE_APP_KEY set, members are read on the key route with Bridge-Workspace', async () => {
    const key = fake.addKey(appId, ['users:read', 'users:write']);
    const env = { BRIDGE_APP_KEY: key };
    expect((await cli.run(['member', 'list', '--workspace', 'cust-1'], { env })).data).toEqual([expect.objectContaining({ id: 'mem-1' })]);
    const request = last('GET', '/v2/accounts/members')!;
    expect(request.headers['x-api-key']).toBe(key);
    expect(request.headers['bridge-workspace']).toBe('cust-1');
    await cli.run(['member', 'update', 'mem-1', '--workspace', 'cust-1', '--role', 'ADMIN'], { env });
    expect(last('PATCH', '/v2/accounts/members/mem-1')?.body).toEqual({ role: 'ADMIN' });
    expect(fake.requests.some((r) => r.path.includes('/workspaces/cust-1/'))).toBe(false);
    expect(fake.keyMints()).toEqual([]);
  });

  it('a workspace that is not the app\'s is not found', async () => {
    expect((await cli.run(['member', 'list', '--workspace', 'nope'])).error).toMatchObject({ code: 'not-found' });
  });

  it('member commands need --workspace', async () => {
    expect((await cli.run(['member', 'list'])).error).toMatchObject({ code: 'usage' });
  });
});
