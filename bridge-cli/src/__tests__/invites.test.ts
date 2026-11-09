/**
 * Invites by email: into the developer's own workspace on Bridge with their
 * token, or into one of the app's workspaces with an app key. Bridge emails
 * the link; the CLI never sees it.
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
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  expect([...fake.keys.values()].filter((k) => k.name === 'bridge-cli (temporary)' && !k.revoked)).toEqual([]);
  cli.cleanup();
});

describe('invites into your own workspace on Bridge', () => {
  it('send, list, send again, revoke: with your token, no app and no key', async () => {
    const sent = await cli.run(['invite', 'send', 'Ann@Example.com', '--role', 'ADMIN']);
    expect(sent.errors).toEqual([]);
    expect(sent.data).toMatchObject({ email: 'ann@example.com', role: 'ADMIN', state: 'open' });
    const request = last('POST', '/v2/accounts/invites')!;
    expect(request.body).toEqual({ email: 'Ann@Example.com', role: 'ADMIN' });
    expect(request.headers['authorization']).toMatch(/^Bearer /);
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['bridge-workspace']).toBeUndefined();

    await cli.run(['invite', 'send', 'bob@example.com']);
    expect(last('POST', '/v2/accounts/invites')?.body).toEqual({ email: 'bob@example.com' });
    expect((await cli.run(['invite', 'list'])).data.map((each: { email: string }) => each.email)).toEqual(['ann@example.com', 'bob@example.com']);

    // Sending again is the same invite with a new link; the list does not grow.
    const again = await cli.run(['invite', 'send', 'ann@example.com']);
    expect(again.data.id).toBe(sent.data.id);
    expect((await cli.run(['invite', 'list'])).data).toHaveLength(2);

    expect((await cli.run(['invite', 'revoke', sent.data.id])).data).toEqual({ revoked: true });
    expect((await cli.run(['invite', 'list'])).data.map((each: { email: string }) => each.email)).toEqual(['bob@example.com']);
    expect((await cli.run(['invite', 'revoke', sent.data.id])).error).toMatchObject({ code: 'not-found' });
    expect(fake.invites('bridge/ws-1')).toHaveLength(2);
    expect(temporaryKeys()).toEqual([]);
  });

  it('a refusal is Bridge\'s own: no email-links address, too many, the Owner role', async () => {
    fake.refuseInvites('no-email-links');
    const refused = await cli.run(['invite', 'send', 'ann@example.com']);
    expect(refused.error).toMatchObject({ code: 'conflict', message: 'The app has no email-links address, so its emails cannot carry a link.' });
    expect(refused.error).not.toHaveProperty('hint');
    expect(refused.exitCode).toBe(1);

    fake.refuseInvites('too-many');
    expect((await cli.run(['invite', 'send', 'ann@example.com'])).error).toMatchObject({ code: 'rate-limited', hint: 'Try again in 3600 seconds.' });

    fake.refuseInvites(null);
    expect((await cli.run(['invite', 'send', 'ann@example.com', '--role', 'OWNER'])).error).toMatchObject({ code: 'conflict' });
    expect((await cli.run(['invite', 'list'])).data).toEqual([]);
  });
});

describe("invites into one of the app's workspaces", () => {
  beforeEach(async () => {
    await cli.run(['app', 'use', appId]);
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' });
  });

  it('send, list, revoke with a short-lived key that holds only what each needs, in Bridge-Workspace', async () => {
    const sent = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'MEMBER']);
    expect(sent.errors).toEqual([]);
    const request = last('POST', '/v2/accounts/invites')!;
    expect(request.body).toEqual({ email: 'carol@customer.example', role: 'MEMBER' });
    expect(request.headers['bridge-workspace']).toBe('cust-1');
    expect(request.headers['x-api-key']).toMatch(new RegExp(`^bk\\.${appId}\\.`));
    expect(request.headers['authorization']).toBeUndefined();
    expect(temporaryKeys().pop()).toEqual({ name: 'bridge-cli (temporary)', privileges: ['USER_WRITE'], expiresInDays: 1 });

    const list = await cli.run(['invite', 'list', '--workspace', 'cust-1']);
    expect(list.data).toEqual([expect.objectContaining({ id: sent.data.id, email: 'carol@customer.example' })]);
    expect(temporaryKeys().pop()).toMatchObject({ privileges: ['USER_READ'] });

    expect((await cli.run(['invite', 'revoke', sent.data.id, '--workspace', 'cust-1'])).data).toEqual({ revoked: true });
    expect(temporaryKeys().pop()).toMatchObject({ privileges: ['USER_WRITE'] });
    expect(fake.invites(`${appId}/cust-1`)).toEqual([expect.objectContaining({ state: 'revoked' })]);
    // The developer's own workspace was never touched.
    expect(fake.invites('bridge/ws-1')).toEqual([]);
  });

  it('uses BRIDGE_APP_KEY when it is set', async () => {
    const key = (await cli.run(['key', 'create', '--name', 'server', '--privilege', 'USER_READ'])).data.key as string;
    const before = temporaryKeys().length;
    await cli.run(['invite', 'list', '--workspace', 'cust-1'], { env: { BRIDGE_APP_KEY: key } });
    expect(temporaryKeys().length).toBe(before);
    expect(last('GET', '/v2/accounts/invites')?.headers['x-api-key']).toBe(key);
  });

  it('an app with no email-links address says how to add one', async () => {
    fake.refuseInvites('no-email-links');
    const refused = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1']);
    expect(refused.error).toMatchObject({
      code: 'conflict',
      status: 409,
      hint: "Add the page that opens your app's email links: `bridge app address add <url> --use email-links`.",
    });
  });

  it('a workspace that is not the app\'s is not found', async () => {
    expect((await cli.run(['invite', 'list', '--workspace', 'nope'])).error).toMatchObject({ code: 'not-found' });
  });
});
