/**
 * Branding, the sign-in methods and their token lifetimes, the event log, the email sender, `info` and the flag commands
 * the 0.x CLI had (toggle, schedule, export, import, a delete preview): each on the version 2 routes the contract lists.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  cli.cleanup();
});

describe('branding', () => {
  it('reads it, and changes only what is given, with the revision it read', async () => {
    expect((await cli.run(['branding', 'get'])).data).toMatchObject({ scheme: 'auto', font: 'system' });
    const done = await cli.run(['branding', 'update', '--bg-color', '#101010', '--primary-btn-bg', '#ff6600', '--font-family', 'Inter, sans-serif', '--border-radius', '8px']);
    expect(done.errors).toEqual([]);
    const request = last('PATCH', '/branding')!;
    expect(request.body).toEqual({ colors: { background: '#101010', primary: '#ff6600' }, scheme: 'dark', font: 'inter', radius: 'medium' });
    expect(request.headers['if-match']).toBe('"1"');
    expect(done.data.branding).toMatchObject({ scheme: 'dark', colors: { background: '#101010', primary: '#ff6600' } });
    expect(fake.branding(appId)['revision']).toBe(2);
  });

  it('says what the page cannot take, and refuses what it cannot', async () => {
    const done = await cli.run(['branding', 'update', '--primary-btn-bg', '#fff', '--primary-btn-text', '#000', '--link-color', '#00f']);
    expect(done.data.notApplied).toEqual(['--primary-btn-text', '--link-color']);
    expect(done.infos.join(' ')).toContain('Not applied');
    expect((await cli.run(['branding', 'update', '--font-family', 'Comic Sans'])).errors).not.toEqual([]);
    expect((await cli.run(['branding', 'update'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['branding', 'update', '--border-radius', 'round'])).errors).not.toEqual([]);
  });
});

describe('auth methods, config and token lifetimes', () => {
  it('lists the methods with what Bridge does not offer yet; switches one; keeps the last', async () => {
    const listed = (await cli.run(['auth', 'methods', 'list'])).data.loginMethods;
    expect(listed).toMatchObject({ password: { enabled: true }, magicLink: { enabled: false }, mfa: { enabled: false }, socialProviders: { google: { enabled: false, note: 'Not available on Bridge yet' } } });
    const on = await cli.run(['auth', 'methods', 'enable', 'magic-link']);
    expect(on.data).toMatchObject({ method: 'magicLink', enabled: true });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ methods: { magicLink: true } });
    expect((await cli.run(['auth', 'methods', 'disable', 'passkeys'])).errors).toEqual([]);
    await cli.run(['auth', 'methods', 'disable', 'magicLink']);
    const last_ = await cli.run(['auth', 'methods', 'disable', 'password']);
    expect(last_.errors).not.toEqual([]);
    expect(fake.requests.filter((r) => r.path.endsWith('/sign-in-settings') && r.method === 'GET').length).toBeGreaterThan(0);
    expect((await cli.run(['auth', 'methods', 'enable', 'google'])).error).toMatchObject({ code: 'not-offered' });
    expect((await cli.run(['auth', 'methods', 'enable', 'carrier-pigeon'])).error).toMatchObject({ code: 'invalid' });
  });

  it('config shows the methods, the lifetimes and the password rules; password-policy sets the lifetimes within bounds', async () => {
    expect((await cli.run(['auth', 'config'])).data).toMatchObject({ tokens: { accessTokenTTL: 300, refreshTokenTTL: 2_592_000, sessionIdleTTL: 1_209_600 }, passwordRules: { minLength: 8 } });
    const set = await cli.run(['auth', 'password-policy', '--access-token-ttl', '120', '--refresh-token-ttl', '86400']);
    expect(set.data.tokens).toEqual({ accessTokenTTL: 120, refreshTokenTTL: 86_400, sessionIdleTTL: 86_400 });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ lifetimes: { accessTokenSeconds: 120, sessionAbsoluteSeconds: 86_400, sessionIdleSeconds: 86_400 } });
    expect((await cli.run(['auth', 'password-policy', '--access-token-ttl', '5000'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('60 to 300') });
    expect((await cli.run(['auth', 'password-policy'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('event list', () => {
  it('lists newest first, filtered by type, workspace and time, in the shape 0.x gave', async () => {
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' });
    fake.addEvent(appId, { type: 'user.login', workspaceId: 'cust-1', userId: 'u-1', data: { via: 'password' } });
    fake.addEvent(appId, { type: 'tenant.created', workspaceId: 'cust-1' });
    const all = await cli.run(['event', 'list']);
    expect(all.data.events.map((each: { type: string }) => each.type)).toEqual(['tenant.created', 'user.login']);
    expect(all.data.events[1]).toEqual({ id: expect.any(String), type: 'user.login', tenantId: 'cust-1', userId: 'u-1', data: { via: 'password' }, createdAt: expect.any(String) });
    expect((await cli.run(['event', 'list', '--type', 'user.login'])).data.events).toHaveLength(1);
    expect((await cli.run(['event', 'list', '--tenant-id', 'Customer One'])).data.events).toHaveLength(2);
    expect((await cli.run(['event', 'list', '--since', '24h', '--limit', '1'])).data.events).toHaveLength(1);
    expect(last('GET', '/events')?.query.get('from')).not.toBeNull();
    expect((await cli.run(['event', 'list', '--since', 'yesterday-ish'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('setup communication and info', () => {
  it('sets the sender, or shows it', async () => {
    expect((await cli.run(['setup', 'communication'])).data).toEqual({ sender: null });
    const set = await cli.run(['setup', 'communication', '--from-address', 'hello@demo.example', '--from-name', 'Demo']);
    expect(last('PUT', '/sender')?.body).toEqual({ address: 'hello@demo.example', name: 'Demo' });
    expect(set.data.sender).toMatchObject({ address: 'hello@demo.example' });
    expect((await cli.run(['setup', 'communication', '--from-name', 'x'])).error).toMatchObject({ code: 'invalid' });
  });

  it('setup status lists what is configured and missing, with the next step, and what production needs', async () => {
    const bare = (await cli.run(['setup', 'status'])).data;
    expect(bare.ready).toBe(false);
    expect(bare.items.find((each: { id: string }) => each.id === 'sign_in_return')).toMatchObject({ status: 'missing', nextStep: 'bridge app address add <url> --use sign-in-return' });
    expect(bare.items.find((each: { id: string }) => each.id === 'payments')).toMatchObject({ status: 'missing' });
    await cli.run(['app', 'address', 'add', 'http://localhost:5173/auth/callback', '--use', 'sign-in-return']);
    await cli.run(['app', 'address', 'add', 'http://localhost:5173', '--use', 'browser-origin']);
    await cli.run(['setup', 'communication', '--from-address', 'hello@demo.example']);
    const next = (await cli.run(['setup', 'status'])).data;
    expect(next.items.find((each: { id: string }) => each.id === 'sign_in_return')).toMatchObject({ status: 'configured' });
    expect(next.items.find((each: { id: string }) => each.id === 'email_sender')).toMatchObject({ status: 'attention' });
    expect(next.productionNeeds).toEqual(expect.arrayContaining(['A sign-in return address that is not on localhost.', 'A browser origin that is not on localhost.', expect.stringContaining('Email sender')]));
  });

  it('info reads the app, the sign-in setup, flags, plans and roles', async () => {
    expect((await cli.run(['info', 'app'])).data).toMatchObject({ app: { id: appId }, signIn: { methods: { password: true } } });
    expect((await cli.run(['info', 'auth-config'])).data).toMatchObject({ methods: { password: true } });
    expect((await cli.run(['info', 'flags'])).data).toEqual([]);
    expect((await cli.run(['info', 'plans'])).data).toEqual([]);
    expect((await cli.run(['info', 'roles'])).data).toEqual([]);
  });
});

describe('flag toggle, schedule, export, import and delete preview', () => {
  beforeEach(async () => {
    await cli.run(['flag', 'create', 'beta-ui']);
  });

  it('toggle: true is on, false is off', async () => {
    expect((await cli.run(['flag', 'toggle', 'beta-ui', '--enabled', 'true'])).data.state).toBe('on');
    expect((await cli.run(['flag', 'toggle', 'beta-ui', '--enabled', 'false'])).data.state).toBe('off');
  });

  it('schedule: set replaces the pending change, list shows it, clear cancels it', async () => {
    const at = '2027-01-01T09:00:00Z';
    const set = await cli.run(['flag', 'schedule', 'set', 'beta-ui', '--at', at, '--state', 'on']);
    expect(set.errors).toEqual([]);
    expect(last('POST', '/schedules')?.body).toEqual({ at: '2027-01-01T09:00:00.000Z', patch: { state: 'on' } });
    expect(last('POST', '/schedules')?.headers['if-match']).toBe('"1"');
    await cli.run(['flag', 'schedule', 'set', 'beta-ui', '--at', '2027-02-01T09:00:00Z', '--state', 'off']);
    expect((await cli.run(['flag', 'schedule', 'list', 'beta-ui'])).data).toHaveLength(1);
    expect((await cli.run(['flag', 'schedule', 'clear', 'beta-ui'])).data).toEqual({ key: 'beta-ui', cleared: 1 });
    expect((await cli.run(['flag', 'schedule', 'list'])).data).toEqual([]);
    expect((await cli.run(['flag', 'schedule', 'set', 'beta-ui', '--at', 'soon', '--state', 'on'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'schedule', 'set', 'beta-ui', '--at', at, '--state', 'maybe'])).errors).not.toEqual([]);
  });

  it('export writes a bundle, import applies it (dry run first), --prune deletes the rest with --yes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-flags-'));
    const out = join(dir, 'flags.json');
    expect((await cli.run(['flag', 'export', '--out', out])).data).toEqual({ written: out, flags: 1 });
    const bundle = JSON.parse(readFileSync(out, 'utf8')) as { version: number; flags: { key: string }[] };
    expect(bundle).toMatchObject({ version: 1, flags: [{ key: 'beta-ui' }] });
    expect((await cli.run(['flag', 'export'])).data.flags).toHaveLength(1);

    bundle.flags.push({ key: 'new-flag', state: 'on' } as never);
    writeFileSync(out, JSON.stringify(bundle));
    const dry = await cli.run(['flag', 'import', out, '--dry-run']);
    expect(dry.data).toMatchObject({ dryRun: true, created: ['new-flag'], unchanged: ['beta-ui'] });
    expect(fake.flags(appId).has('new-flag')).toBe(false);
    expect((await cli.run(['flag', 'import', out])).data).toMatchObject({ created: ['new-flag'] });
    expect(fake.flags(appId).has('new-flag')).toBe(true);

    writeFileSync(out, JSON.stringify({ version: 1, flags: [{ key: 'new-flag', state: 'on' }] }));
    const kept = await cli.run(['flag', 'import', out]);
    expect(kept.data.extraneous).toEqual(['beta-ui']);
    expect(kept.infos.join(' ')).toContain('Nothing was deleted');
    expect((await cli.run(['flag', 'import', out, '--prune'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'import', out, '--prune', '--dry-run'])).data).toMatchObject({ wouldDelete: ['beta-ui'] });
    expect((await cli.run(['flag', 'import', out, '--prune', '--yes'])).data).toMatchObject({ deleted: ['beta-ui'] });
    expect(fake.flags(appId).has('beta-ui')).toBe(false);
    writeFileSync(out, '{ not json');
    expect((await cli.run(['flag', 'import', out])).error).toMatchObject({ code: 'invalid' });
  });

  it('delete: --dry-run says what it would do and deletes nothing; without --yes it refuses', async () => {
    expect((await cli.run(['flag', 'delete', 'beta-ui', '--dry-run'])).data).toMatchObject({ dryRun: true, target: { key: 'beta-ui' } });
    expect(fake.flags(appId).has('beta-ui')).toBe(true);
    expect((await cli.run(['flag', 'delete', 'beta-ui'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'delete', 'beta-ui', '--yes'])).errors).toEqual([]);
    expect(fake.flags(appId).has('beta-ui')).toBe(false);
  });
});

describe('auth terms-line (TBP-864)', () => {
  it('shows the line on by default, and says it is not shown while the pages are placeholders', async () => {
    await cli.run(['app', 'update', '--terms-of-service', 'https://your-landing-page.com/terms', '--privacy-policy', 'https://acme.com/privacy']);
    const shown = await cli.run(['auth', 'terms-line']);
    expect(shown.errors).toEqual([]);
    expect(shown.data.termsLine).toEqual({ enabled: true, shown: false, missingPages: ['termsOfService'] });
    expect(shown.infos.join(' ')).toContain('bridge app update --terms-of-service');
    expect(last('PATCH', '/sign-in-settings')).toBeUndefined();
  });

  it('switches it off and on with the sign-in settings change, and shows it in auth config', async () => {
    await cli.run(['app', 'update', '--terms-of-service', 'https://acme.com/terms', '--privacy-policy', 'https://acme.com/privacy']);
    const off = await cli.run(['auth', 'terms-line', 'off']);
    expect(off.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ signUpTerms: false });
    expect(off.data.termsLine).toEqual({ enabled: false, shown: false });
    expect(off.infos.join(' ')).not.toContain('bridge app update');
    expect((await cli.run(['auth', 'config'])).data.termsLine).toEqual({ enabled: false });
    const on = await cli.run(['auth', 'terms-line', 'ON']);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ signUpTerms: true });
    expect(on.data.termsLine).toEqual({ enabled: true, shown: true });
  });

  it('refuses anything but on or off, and changes nothing', async () => {
    expect((await cli.run(['auth', 'terms-line', 'maybe'])).error).toMatchObject({ code: 'invalid' });
    expect(last('PATCH', '/sign-in-settings')).toBeUndefined();
  });
});
