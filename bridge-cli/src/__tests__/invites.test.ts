/**
 * Invites by email: into the developer's own workspace on Bridge, or into one
 * of the app's workspaces, both with their sign-in (with BRIDGE_APP_KEY set,
 * as the app's server on the key routes). Bridge emails the link; the CLI
 * never sees it.
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
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  expect(fake.keyMints()).toEqual([]);
  cli.cleanup();
});

describe('invites into your own workspace on Bridge', () => {
  it('role OWNER needs a recent sign-in, and says so', async () => {
    expect((await cli.run(['invite', 'send', 'ann@example.com', '--role', 'OWNER'])).data).toMatchObject({ role: 'OWNER' });
    fake.advance(10 * 60_000);
    expect((await cli.run(['invite', 'send', 'bob@example.com', '--role', 'OWNER'])).error).toMatchObject({ code: 'reauthenticate' });
  });

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
  });

  it('a refusal is Bridge\'s own: no email-links address, too many', async () => {
    fake.refuseInvites('no-email-links');
    const refused = await cli.run(['invite', 'send', 'ann@example.com']);
    expect(refused.error).toMatchObject({ code: 'conflict', message: 'The app has no email-links address, so its emails cannot carry a link.' });
    expect(refused.error).not.toHaveProperty('hint');
    expect(refused.exitCode).toBe(1);

    fake.refuseInvites('too-many');
    expect((await cli.run(['invite', 'send', 'ann@example.com'])).error).toMatchObject({ code: 'rate-limited', hint: 'Try again in 3600 seconds.' });

    fake.refuseInvites(null);
    expect((await cli.run(['invite', 'list'])).data).toEqual([]);
  });

  it('--first-name and --last-name go on the invite', async () => {
    const sent = await cli.run(['invite', 'send', 'ann@example.com', '--first-name', 'Ann', '--last-name', 'Lee']);
    expect(sent.errors).toEqual([]);
    expect(last('POST', '/v2/accounts/invites')?.body).toEqual({ email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' });
    expect(sent.data).toMatchObject({ firstName: 'Ann', lastName: 'Lee' });
  });
});

describe("invites into one of the app's workspaces", () => {
  beforeEach(async () => {
    await cli.run(['app', 'use', appId]);
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' });
  });

  it('send, list, revoke on the operator routes with your sign-in: the workspace is in the path, no key is made', async () => {
    const base = `/v2/accounts/apps/${appId}/workspaces/cust-1/invites`;
    const sent = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'MEMBER']);
    expect(sent.errors).toEqual([]);
    const request = last('POST', base)!;
    expect(request.path).toBe(base);
    expect(request.body).toEqual({ email: 'carol@customer.example', role: 'MEMBER' });
    expect(request.headers['authorization']).toMatch(/^Bearer /);
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['bridge-workspace']).toBeUndefined();

    const list = await cli.run(['invite', 'list', '--workspace', 'cust-1']);
    expect(list.data).toEqual([expect.objectContaining({ id: sent.data.id, email: 'carol@customer.example' })]);
    expect(last('GET', base)?.headers['authorization']).toMatch(/^Bearer /);

    expect((await cli.run(['invite', 'revoke', sent.data.id, '--workspace', 'cust-1'])).data).toEqual({ revoked: true });
    expect(last('DELETE', `${base}/${String(sent.data.id)}`)?.headers['authorization']).toMatch(/^Bearer /);
    expect(fake.invites(`${appId}/cust-1`)).toEqual([expect.objectContaining({ state: 'revoked', invitedBy: expect.any(String) })]);
    // The developer's own workspace was never touched, and no key route was called.
    expect(fake.invites('bridge/ws-1')).toEqual([]);
    expect(fake.requests.some((r) => r.headers['x-api-key'] !== undefined)).toBe(false);
  });

  it('with BRIDGE_APP_KEY set, the key routes are used as the app\'s server, with the key and no sign-in', async () => {
    const key = fake.addKey(appId, ['USER_READ', 'USER_WRITE']);
    const env = { BRIDGE_APP_KEY: key };
    const sent = await cli.run(['invite', 'send', 'dave@customer.example', '--workspace', 'cust-1'], { env });
    expect(sent.errors).toEqual([]);
    const request = last('POST', '/v2/accounts/invites')!;
    expect(request.headers['x-api-key']).toBe(key);
    expect(request.headers['bridge-workspace']).toBe('cust-1');
    expect(request.headers['authorization']).toBeUndefined();
    await cli.run(['invite', 'list', '--workspace', 'cust-1'], { env });
    expect(last('GET', '/v2/accounts/invites')?.headers['x-api-key']).toBe(key);
    expect((await cli.run(['invite', 'revoke', sent.data.id, '--workspace', 'cust-1'], { env })).data).toEqual({ revoked: true });
    expect(fake.keyMints()).toEqual([]);
    expect(fake.requests.some((r) => r.path.startsWith(`/v2/accounts/apps/${appId}/`))).toBe(false);
  });

  it('--first-name and --last-name go on the operator invite', async () => {
    const sent = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--first-name', 'Carol', '--last-name', 'King']);
    expect(sent.errors).toEqual([]);
    expect(last('POST', `/v2/accounts/apps/${appId}/workspaces/cust-1/invites`)?.body).toEqual({ email: 'carol@customer.example', firstName: 'Carol', lastName: 'King' });
  });

  it('role OWNER is allowed with a recent sign-in', async () => {
    const sent = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'OWNER']);
    expect(sent.errors).toEqual([]);
    expect(sent.data).toMatchObject({ role: 'OWNER', state: 'open' });
    expect(last('POST', `/v2/accounts/apps/${appId}/workspaces/cust-1/invites`)?.body).toEqual({ email: 'carol@customer.example', role: 'OWNER' });
  });

  it('role OWNER long after sign-in: shows the same recent-sign-in message as the other re-check cases', async () => {
    fake.advance(10 * 60_000);
    const done = await cli.run(['invite', 'send', 'carol@customer.example', '--workspace', 'cust-1', '--role', 'OWNER']);
    expect(done.error).toMatchObject({ code: 'reauthenticate', status: 401 });
    expect(String(done.error?.['hint'])).toBe('This needs a recent sign-in. Sign in again with `bridge auth login`, then run it again within 5 minutes of signing in.');
    expect(fake.invites(`${appId}/cust-1`)).toEqual([]);
    // Another role needs no re-check.
    expect((await cli.run(['invite', 'send', 'dave@customer.example', '--workspace', 'cust-1', '--role', 'ADMIN'])).errors).toEqual([]);
  });

  it('with BRIDGE_APP_KEY set, the names and the Owner role go on the key route', async () => {
    const key = fake.addKey(appId, ['USER_WRITE']);
    fake.advance(10 * 60_000);
    const sent = await cli.run(['invite', 'send', 'erin@customer.example', '--workspace', 'cust-1', '--role', 'OWNER', '--first-name', 'Erin'], { env: { BRIDGE_APP_KEY: key } });
    expect(sent.errors).toEqual([]);
    expect(last('POST', '/v2/accounts/invites')?.body).toEqual({ email: 'erin@customer.example', role: 'OWNER', firstName: 'Erin' });
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
