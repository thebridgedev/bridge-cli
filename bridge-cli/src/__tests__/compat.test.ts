/**
 * The 0.x forms of the team, workspace and key commands (`tenant`, `user`, `token`, `role set-default`), on the version 2
 * routes, with the previews `--dry-run` gave: what a delete would do, and nothing deleted.
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
  fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One', state: 'active' }, [
    { id: 'm-1', user: { id: 'u-1', email: 'owner@customer.example', firstName: 'Olive', lastName: null }, role: 'OWNER', status: 'active' },
    { id: 'm-2', user: { id: 'u-2', email: 'pat@customer.example', firstName: 'Pat', lastName: null }, role: 'MEMBER', status: 'active' },
  ]);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('tenant', () => {
  it('lists, gets by name or by id, creates with an owner and a plan, updates, moves plan', async () => {
    expect((await cli.run(['tenant', 'list'])).data).toEqual([expect.objectContaining({ id: 'cust-1' })]);
    expect((await cli.run(['tenant', 'get', '--name', 'Customer One'])).data).toMatchObject({ id: 'cust-1' });
    expect((await cli.run(['tenant', 'get', '--id', 'cust-1'])).data).toMatchObject({ name: 'Customer One' });
    expect((await cli.run(['tenant', 'get', '--name', 'Nobody'])).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['tenant', 'get'])).error).toMatchObject({ code: 'invalid' });

    const made = await cli.run(['tenant', 'create', '--owner-email', 'new@customer.example', '--name', 'Two', '--locale', 'sv']);
    expect(made.errors).toEqual([]);
    expect(last('POST', `/v2/accounts/apps/${appId}/workspaces`)?.body).toEqual({ owner: { email: 'new@customer.example' }, name: 'Two', locale: 'sv' });

    await cli.run(['tenant', 'update', '--name', 'Customer One', '--new-name', 'One', '--locale', 'en']);
    expect(last('PATCH', '/workspaces/cust-1')?.body).toEqual({ name: 'One', locale: 'en' });
    expect((await cli.run(['tenant', 'update', '--name', 'One'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('Nothing to change') });

    await cli.run(['tenant', 'set-plan', '--name', 'One', '--plan', 'pro', '--interval', 'month', '--currency', 'eur']);
    expect(last('PUT', '/payer/subscription')?.body).toEqual({ plan: 'pro', interval: 'month', currency: 'EUR' });
  });

  it('delete: --dry-run shows the people and the 30 days and deletes nothing; without --yes it refuses', async () => {
    const preview = await cli.run(['tenant', 'delete', '--name', 'Customer One', '--dry-run']);
    expect(preview.data).toMatchObject({ dryRun: true, target: { id: 'cust-1' }, affects: { members: 2, owners: 1 } });
    expect(JSON.stringify(preview.data.sideEffects)).toContain('any Owner of the workspace can restore it');
    expect(last('DELETE', '/workspaces/cust-1')).toBeUndefined();
    expect((await cli.run(['tenant', 'delete', '--name', 'Customer One'])).error).toMatchObject({ code: 'invalid' });
    expect(last('DELETE', '/workspaces/cust-1')).toBeUndefined();
    const gone = await cli.run(['tenant', 'delete', '--id', 'cust-1', '--yes']);
    expect(gone.data).toMatchObject({ state: 'deletion_scheduled' });
    expect(last('DELETE', '/workspaces/cust-1')?.headers['authorization']).toMatch(/^Bearer /);
  });

  it('get, update, set-plan and delete find the tenant in the app they act on, the same way, even with BRIDGE_APP_KEY set', async () => {
    const env = { BRIDGE_APP_KEY: 'bk.some-other-key' };
    fake.requests.length = 0;
    const preview = await cli.run(['tenant', 'delete', '--name', 'Customer One', '--dry-run'], { env });
    expect(preview.data).toMatchObject({ dryRun: true, target: { id: 'cust-1' } });
    expect((await cli.run(['tenant', 'get', '--name', 'Customer One'], { env })).data).toMatchObject({ id: 'cust-1' });
    const lookups = fake.requests.filter((r) => r.method === 'GET' && r.path.includes('/workspaces'));
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(lookup.path).toContain(`/apps/${appId}/`);
      expect(lookup.headers['x-api-key']).toBeUndefined();
    }
  });
});

describe('user', () => {
  it('list, get, update and remove in the workspace named by --tenant-id or BRIDGE_TENANT_ID', async () => {
    expect((await cli.run(['user', 'list', '--tenant-id', 'cust-1'])).data).toHaveLength(2);
    expect((await cli.run(['user', 'list'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'get', '--email', 'PAT@customer.example'], { env: { BRIDGE_TENANT_ID: 'cust-1' } })).data).toMatchObject({ id: 'm-2' });
    expect((await cli.run(['user', 'get', '--user-id', 'u-2', '--tenant-id', 'cust-1'])).data).toMatchObject({ id: 'm-2' });
    expect((await cli.run(['user', 'get', '--email', 'no@customer.example', '--tenant-id', 'cust-1'])).error).toMatchObject({ code: 'not-found' });
    await cli.run(['user', 'update', '--email', 'pat@customer.example', '--tenant-id', 'cust-1', '--role', 'ADMIN', '--enabled', 'false']);
    expect(last('PATCH', '/members/m-2')?.body).toEqual({ role: 'ADMIN', enabled: false });
  });

  it('invite needs the role: without it the command stops and asks, and sends nothing', async () => {
    const asked = await cli.run(['user', 'invite', '--email', 'x@customer.example', '--tenant-id', 'cust-1']);
    expect(asked.error).toMatchObject({ code: 'DECISION_NEEDED' });
    expect(String(asked.error?.['message'])).toContain('bridge user invite');
    expect(last('POST', '/invites')).toBeUndefined();
    const sent = await cli.run(['user', 'invite', '--email', 'x@customer.example', '--role', 'MEMBER', '--tenant-id', 'cust-1', '--first-name', 'Xi']);
    expect(sent.errors).toEqual([]);
    expect(last('POST', '/invites')?.body).toEqual({ email: 'x@customer.example', role: 'MEMBER', firstName: 'Xi' });
  });

  it('remove: --dry-run says whether it is the last Owner; without --yes it refuses', async () => {
    const owner = await cli.run(['user', 'remove', '--email', 'owner@customer.example', '--tenant-id', 'cust-1', '--dry-run']);
    expect(owner.data).toMatchObject({ dryRun: true, affects: { accountDeleted: false, lastOwner: true } });
    expect(JSON.stringify(owner.data.sideEffects)).toContain('only Owner');
    const member = await cli.run(['user', 'remove', '--email', 'pat@customer.example', '--tenant-id', 'cust-1', '--dry-run']);
    expect(member.data).toMatchObject({ affects: { lastOwner: false } });
    expect(last('DELETE', '/members/')).toBeUndefined();
    expect((await cli.run(['user', 'remove', '--email', 'pat@customer.example', '--tenant-id', 'cust-1'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'remove', '--email', 'pat@customer.example', '--tenant-id', 'cust-1', '--yes'])).errors).toEqual([]);
    expect(last('DELETE', '/members/m-2')).toBeDefined();
  });
});

describe('token', () => {
  it('list, create with privileges and an expiry date, revoke by name or id; --dry-run revokes nothing', async () => {
    const soon = new Date(fake.now() + 10 * 86_400_000).toISOString();
    const made = await cli.run(['token', 'create', '--name', 'ci', '--privileges', 'POSTS_READ, POSTS_WRITE', '--expire-at', soon]);
    expect(made.errors).toEqual([]);
    expect(last('POST', '/keys')?.body).toEqual({ name: 'ci', privileges: ['POSTS_READ', 'POSTS_WRITE'], expiresInDays: 10 });
    expect(made.infos.join(' ')).toContain('shown this once');
    expect((await cli.run(['token', 'create', '--name', 'far', '--expire-at', new Date(fake.now() + 400 * 86_400_000).toISOString()])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['token', 'list'])).data).toEqual([expect.objectContaining({ name: 'ci' })]);

    const preview = await cli.run(['token', 'revoke', '--name', 'ci', '--dry-run']);
    expect(preview.data).toMatchObject({ dryRun: true, target: { name: 'ci', privileges: ['POSTS_READ', 'POSTS_WRITE'] } });
    expect(last('DELETE', '/keys/')).toBeUndefined();
    expect((await cli.run(['token', 'revoke', '--name', 'ci'])).data).toEqual({ revoked: made.data.id });
    expect((await cli.run(['token', 'revoke', '--name', 'ci'])).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['token', 'revoke'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('role set-default', () => {
  it('makes a role the default by its key', async () => {
    await cli.run(['role', 'create', 'viewer', '--name', 'Viewer']);
    expect((await cli.run(['role', 'set-default', 'viewer'])).errors).toEqual([]);
    expect(last('PATCH', '/roles/')?.body).toEqual({ isDefault: true });
    expect((await cli.run(['role', 'set-default', 'nobody'])).error).toMatchObject({ code: 'not-found' });
  });
});
