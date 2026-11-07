/** Apps, their addresses, and app keys, on the developer's operator routes at /v2. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

const last = (method: string, suffix: string) => fake.requests.filter((r) => r.method === method && r.path.endsWith(suffix)).pop();

describe('app', () => {
  it('create: makes the app with its addresses, and chooses it', async () => {
    const done = await cli.run([
      'app', 'create', '--name', 'Demo',
      '--sign-in-return', 'https://demo.example.com/auth/callback',
      '--email-links', 'https://demo.example.com/auth/link',
      '--browser-origin', 'https://demo.example.com',
      '--website', 'https://demo.example.com',
    ]);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/v2/app-registry/apps')?.body).toEqual({
      name: 'Demo',
      website: 'https://demo.example.com',
      addresses: [
        { url: 'https://demo.example.com/auth/callback', uses: ['sign-in-return'] },
        { url: 'https://demo.example.com/auth/link', uses: ['email-links'] },
        { url: 'https://demo.example.com', uses: ['browser-origin'] },
      ],
      defaultReturn: 'https://demo.example.com/auth/callback',
    });
    const appId = done.data.id as string;
    expect(JSON.parse(readFileSync(join(cli.dir, 'config.json'), 'utf8')).apps).toEqual({ [ISSUER]: appId });
    const list = await cli.run(['app', 'list']);
    expect(list.data).toEqual([expect.objectContaining({ id: appId, current: true })]);
    expect(last('GET', '/v2/app-registry/apps')?.headers['authorization']).toMatch(/^Bearer /);
  });

  it('use / get / update / delete act on the chosen app', async () => {
    const appId = fake.addApp({ name: 'Existing', owner: 'ws-1' });
    expect((await cli.run(['app', 'use', appId])).data).toEqual({ id: appId, name: 'Existing' });
    expect((await cli.run(['app', 'get'])).data.id).toBe(appId);
    const updated = await cli.run(['app', 'update', '--name', 'Renamed', '--logo', 'https://cdn.example.com/logo.png', '--terms-of-service', 'none']);
    expect(last('PATCH', `/v2/app-registry/apps/${appId}`)?.body).toEqual({ name: 'Renamed', logo: 'https://cdn.example.com/logo.png', termsOfService: null });
    expect(updated.data.name).toBe('Renamed');
    expect((await cli.run(['app', 'delete'])).error).toMatchObject({ code: 'usage' });
    expect((await cli.run(['app', 'delete', '--yes'])).errors).toEqual([]);
    expect(last('DELETE', `/v2/app-registry/apps/${appId}`)).toBeDefined();
    expect((await cli.run(['app', 'get'])).error).toMatchObject({ code: 'misconfigured', message: 'No app is chosen.' });
  });

  it('--app acts on another app for one command; an app of another workspace is not found', async () => {
    const mine = fake.addApp({ name: 'Mine', owner: 'ws-1' });
    const theirs = fake.addApp({ name: 'Theirs', owner: 'ws-other' });
    expect((await cli.run(['app', 'get', '--app', mine])).data.name).toBe('Mine');
    expect((await cli.run(['app', 'get', '--app', theirs])).error).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('address add merges uses into the app\'s list; remove takes uses off and clears a default return that went', async () => {
    const appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
    await cli.run(['app', 'use', appId]);
    await cli.run(['app', 'address', 'add', 'http://localhost:5173/auth/callback', '--use', 'sign-in-return']);
    const both = await cli.run(['app', 'address', 'add', 'http://localhost:5173/auth/callback', '--use', 'email-links', '--use', 'sign-in-return']);
    expect(both.data.addresses).toEqual([{ url: 'http://localhost:5173/auth/callback', uses: ['sign-in-return', 'email-links'] }]);
    await cli.run(['app', 'address', 'add', 'http://localhost:5173', '--use', 'browser-origin']);
    expect((await cli.run(['app', 'default-return', 'http://localhost:5173/auth/callback'])).data.defaultReturn).toBe('http://localhost:5173/auth/callback');

    const removed = await cli.run(['app', 'address', 'remove', 'http://localhost:5173/auth/callback', '--use', 'sign-in-return']);
    expect(removed.errors).toEqual([]);
    expect(last('PATCH', `/apps/${appId}`)?.body).toEqual({
      addresses: [
        { url: 'http://localhost:5173/auth/callback', uses: ['email-links'] },
        { url: 'http://localhost:5173', uses: ['browser-origin'] },
      ],
      defaultReturn: null,
    });
    const gone = await cli.run(['app', 'address', 'remove', 'http://localhost:5173']);
    expect(gone.data.addresses).toEqual([{ url: 'http://localhost:5173/auth/callback', uses: ['email-links'] }]);
    expect((await cli.run(['app', 'address', 'list'])).data.addresses).toHaveLength(1);
  });

  it('refuses a use that is not one', async () => {
    const appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
    const done = await cli.run(['app', 'address', 'add', 'https://x.example.com', '--use', 'redirect', '--app', appId]);
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(String(done.error?.['message'])).toContain('sign-in-return, browser-origin, email-links, sign-out, checkout-return');
  });
});

describe('key', () => {
  let appId: string;
  beforeEach(async () => {
    appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
    await cli.run(['app', 'use', appId]);
  });

  it('create shows the secret once; list and revoke', async () => {
    const made = await cli.run(['key', 'create', '--name', 'production server', '--privilege', 'USER_READ', '--expires-in-days', '30']);
    expect(last('POST', `/v2/identity-access/apps/${appId}/keys`)?.body).toEqual({ name: 'production server', privileges: ['USER_READ'], expiresInDays: 30 });
    expect(made.data.key).toMatch(new RegExp(`^bk\\.${appId}\\.`));
    expect(made.infos.join('\n')).toContain('shown this once');
    const list = await cli.run(['key', 'list']);
    expect(list.data).toEqual([expect.objectContaining({ id: made.data.id, name: 'production server' })]);
    expect(JSON.stringify(list.data)).not.toContain(made.data.key);
    expect((await cli.run(['key', 'revoke', made.data.id])).data).toEqual({ revoked: made.data.id });
    expect((await cli.run(['key', 'list'])).data).toEqual([]);
  });

  it('create long after sign-in: says to sign in again', async () => {
    fake.advance(10 * 60_000);
    const done = await cli.run(['key', 'create', '--name', 'late']);
    expect(done.error).toMatchObject({ code: 'reauthenticate', status: 401 });
    expect(String(done.error?.['hint'])).toContain('within 5 minutes');
  });

  it('refuses days outside 1 to 365 before calling', async () => {
    const before = fake.requests.length;
    expect((await cli.run(['key', 'create', '--name', 'x', '--expires-in-days', '400'])).error).toMatchObject({ code: 'usage' });
    expect(fake.requests.length).toBe(before);
  });
});
