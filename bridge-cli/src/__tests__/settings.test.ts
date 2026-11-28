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
    expect(listed).toMatchObject({ password: { enabled: true }, magicLink: { enabled: false }, mfa: { enabled: false }, socialProviders: { google: { name: 'Google', enabled: false, credentialsSaved: false }, microsoft: { name: 'Microsoft', enabled: false }, apple: { name: 'Apple', enabled: false, credentialsSaved: false } } });
    expect(JSON.stringify(listed)).not.toContain('Azure');
    const on = await cli.run(['auth', 'methods', 'enable', 'magic-link']);
    expect(on.data).toMatchObject({ method: 'magicLink', enabled: true });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ methods: { magicLink: true } });
    expect((await cli.run(['auth', 'methods', 'disable', 'passkeys'])).errors).toEqual([]);
    await cli.run(['auth', 'methods', 'disable', 'magicLink']);
    const last_ = await cli.run(['auth', 'methods', 'disable', 'password']);
    expect(last_.errors).not.toEqual([]);
    expect(fake.requests.filter((r) => r.path.endsWith('/sign-in-settings') && r.method === 'GET').length).toBeGreaterThan(0);
    // Apple (TBP-778) is a provider now: it switches on once its details are saved.
    expect((await cli.run(['auth', 'methods', 'enable', 'apple'])).error).toMatchObject({ code: 'invalid', hint: expect.stringContaining('--private-key-file') });
    // A provider switches on only once its credentials are saved (TBP-134).
    expect((await cli.run(['auth', 'methods', 'enable', 'google'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('not saved yet') });
    expect((await cli.run(['auth', 'methods', 'enable', 'carrier-pigeon'])).error).toMatchObject({ code: 'invalid' });
  });

  it('shows and switches when a passkey is offered (TBP-536): after sign-in, and made automatically', async () => {
    expect((await cli.run(['auth', 'methods', 'list'])).data.loginMethods.passkeys).toEqual({ enabled: false, offerAfterSignIn: true, createAutomatically: true });
    const shown = await cli.run(['auth', 'methods', 'passkey-offer']);
    expect(shown.data).toMatchObject({ passkeys: false, offerAfterSignIn: true, createAutomatically: true, note: expect.stringContaining('Passkeys are off') });
    const changed = await cli.run(['auth', 'methods', 'passkey-offer', '--automatic', 'off']);
    expect(changed.data).toMatchObject({ offerAfterSignIn: true, createAutomatically: false });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ passkeyOffer: { automatic: false } });
    expect((await cli.run(['auth', 'methods', 'passkey-offer', '--after-sign-in', 'maybe'])).errors).not.toEqual([]);
  });

  it('config shows the methods, the lifetimes and the password rules; password-policy still sets the lifetimes within bounds, and says they moved', async () => {
    expect((await cli.run(['auth', 'config'])).data).toMatchObject({ tokens: { accessTokenTTL: 300, refreshTokenTTL: 2_592_000, sessionIdleTTL: 1_209_600 }, passwordRules: { minLength: 8 }, commonPasswordList: 'updated 2026-11-27', productionFloor: 'basic (kept from before the move)' });
    const set = await cli.run(['auth', 'password-policy', '--access-token-ttl', '120', '--refresh-token-ttl', '86400']);
    expect(set.data.tokens).toEqual({ accessTokenTTL: 120, refreshTokenTTL: 86_400, sessionIdleTTL: 86_400 });
    expect(set.infos.join(' ')).toContain('bridge auth token-lifetime');
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ lifetimes: { accessTokenSeconds: 120, sessionAbsoluteSeconds: 86_400, sessionIdleSeconds: 86_400 } });
    expect((await cli.run(['auth', 'password-policy', '--access-token-ttl', '5000'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('60 to 300') });
    expect((await cli.run(['auth', 'password-policy'])).error).toMatchObject({ code: 'invalid' });
  });

  it('password-policy sets the real password rules: a preset with its badge, or custom rules never below 8 (TBP-216)', async () => {
    const strict = await cli.run(['auth', 'password-policy', '--preset', 'strict']);
    expect(strict.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ password: { preset: 'strict' } });
    expect(strict.data).toMatchObject({ passwordRules: { preset: 'strict', minLength: 15 }, badge: 'Follows NIST password guidelines (SP 800-63B)', commonPasswordList: 'updated 2026-11-27' });
    expect(strict.data.tokens).toBeUndefined();
    const custom = await cli.run(['auth', 'password-policy', '--preset', 'custom', '--min-length', '16', '--block-common', '--block-app-name', 'true', '--require-symbol', 'false']);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ password: { preset: 'custom', minLength: 16, requireUpper: false, requireLower: false, requireDigit: false, requireSymbol: false, blockEmail: false, blockCommon: true, blockAppName: true } });
    expect(custom.data.badge).toBeUndefined();
    expect((await cli.run(['auth', 'password-policy', '--preset', 'custom', '--min-length', '6'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('8 to 128') });
    expect((await cli.run(['auth', 'password-policy', '--preset', 'strict', '--min-length', '20'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['auth', 'password-policy', '--preset', 'relaxed'])).error).toMatchObject({ code: 'invalid' });
    const compliance = await cli.run(['auth', 'password-policy', '--preset', 'compliance']);
    expect(compliance.data.badge).toBe('Meets common audit checklists');
    // Production keeps Recommended (TBP-872): a looser change is refused with what to do.
    fake.holdAtRecommended(appId);
    expect((await cli.run(['auth', 'password-policy', '--preset', 'basic'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('Recommended') });
  });

  it('token-lifetime sets the lifetimes on their own (D11)', async () => {
    const set = await cli.run(['auth', 'token-lifetime', '--access-token-ttl', '120', '--session-idle-ttl', '3600']);
    expect(set.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ lifetimes: { accessTokenSeconds: 120, sessionIdleSeconds: 3600 } });
    expect(set.data.tokens).toEqual({ accessTokenTTL: 120, refreshTokenTTL: 2_592_000, sessionIdleTTL: 3600 });
    expect((await cli.run(['auth', 'token-lifetime', '--access-token-ttl', '5000'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('60 to 300') });
    expect((await cli.run(['auth', 'token-lifetime'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('auth providers (TBP-134, TBP-859)', () => {
  it("saves a provider's credentials, prints the return address to register, and switches it on", async () => {
    const set = await cli.run(['auth', 'providers', 'set', 'github', '--client-id', 'gh-id', '--client-secret', 'gh-secret', '--enable']);
    expect(set.errors).toEqual([]);
    expect(fake.savedProvider(appId, 'github')).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    expect(set.data).toMatchObject({ provider: 'github', name: 'GitHub', enabled: true, credentialsSaved: true, returnAddress: expect.stringContaining('/federated/github/return') });
    expect(set.infos.join(' ')).toContain('/federated/github/return');
    expect(JSON.stringify(set.data)).not.toContain('gh-secret');
    expect((await cli.run(['auth', 'methods', 'list'])).data.loginMethods.socialProviders.github).toMatchObject({ enabled: true, credentialsSaved: true });
    expect((await cli.run(['auth', 'methods', 'disable', 'github'])).data).toMatchObject({ method: 'github', enabled: false });
  });

  it('Microsoft: who can sign in, a directory, the secret expiry, and the Microsoft name (API key azure)', async () => {
    const any = await cli.run(['auth', 'providers', 'set', 'microsoft', '--client-id', 'ms-id', '--client-secret', 'ms-secret']);
    expect(any.errors).toEqual([]);
    expect(fake.savedProvider(appId, 'azure')).toEqual({ clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'common' });
    expect(any.data).toMatchObject({ provider: 'microsoft', whoCanSignIn: 'any', returnAddress: expect.stringContaining('/federated/azure/return') });
    expect(any.infos.join(' ')).toContain('Register this return address with Microsoft');
    await cli.run(['auth', 'providers', 'set', 'microsoft', '--client-id', 'ms-id', '--client-secret', 'ms-secret', '--who-can-sign-in', 'work', '--secret-expires-at', '2028-06-30']);
    expect(fake.savedProvider(appId, 'azure')).toEqual({ clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'organizations', secretExpiresAt: '2028-06-30' });
    const directory = await cli.run(['auth', 'providers', 'set', 'microsoft', '--client-id', 'ms-id', '--client-secret', 'ms-secret', '--directory', 'contoso.onmicrosoft.com']);
    expect(directory.data).toMatchObject({ whoCanSignIn: 'directory', directory: 'contoso.onmicrosoft.com' });
    expect((await cli.run(['auth', 'providers', 'set', 'microsoft', '--client-id', 'a', '--client-secret', 'b', '--who-can-sign-in', 'directory'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['auth', 'providers', 'set', 'google', '--client-id', 'a', '--client-secret', 'b', '--who-can-sign-in', 'work'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['auth', 'providers', 'set', 'apple', '--client-id', 'a', '--client-secret', 'b'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('no client secret') });
    const listed = (await cli.run(['auth', 'providers', 'list'])).data.providers;
    expect(listed.microsoft).toMatchObject({ name: 'Microsoft', credentialsSaved: true, secretExpiry: 'ok' });
    expect(JSON.stringify(listed)).not.toContain('Azure');
  });

  it('Apple (TBP-778): the Services ID, Team ID, Key ID and the .p8 file, no secret; prints the domain and return address to register', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'apple-')), 'AuthKey_KEY1234567.p8');
    writeFileSync(file, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    expect((await cli.run(['auth', 'providers', 'set', 'apple', '--client-id', 'com.acme.signin', '--team-id', 'TEAM123456'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('--key-id') });
    expect((await cli.run(['auth', 'providers', 'set', 'github', '--client-id', 'a', '--client-secret', 'b', '--team-id', 'TEAM123456'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['auth', 'providers', 'set', 'github', '--client-id', 'a'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('--client-secret') });
    const set = await cli.run(['auth', 'providers', 'set', 'apple', '--client-id', 'com.acme.signin', '--team-id', 'TEAM123456', '--key-id', 'KEY1234567', '--private-key-file', file, '--enable']);
    expect(set.errors).toEqual([]);
    expect(fake.savedProvider(appId, 'apple')).toEqual({ clientId: 'com.acme.signin', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' });
    expect(set.data).toMatchObject({ provider: 'apple', name: 'Apple', enabled: true, credentialsSaved: true, teamId: 'TEAM123456', keyId: 'KEY1234567', returnAddress: expect.stringContaining('/federated/apple/return') });
    expect(set.infos.join(' ')).toContain('Domains and Subdomains');
    expect(set.infos.join(' ')).toContain('Email Communication');
    expect(JSON.stringify(set.data)).not.toContain('PRIVATE KEY');
  });
});

describe('user passkeys (TBP-861)', () => {
  beforeEach(() => {
    fake.addUser(appId, { id: 'user-1', email: 'anna@acme.example' });
    fake.userPasskeys(appId, 'user-1').push({ id: 'pk-1', name: 'Work laptop', authenticator: { name: 'iCloud Keychain', icon: null }, createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, deviceType: 'multiDevice', backedUp: true });
  });

  it("lists a user's passkeys by email, and removes one with --yes", async () => {
    const listed = await cli.run(['user', 'passkeys', 'list', 'anna@acme.example']);
    expect(listed.data).toEqual({ user: 'anna@acme.example', passkeys: [{ id: 'pk-1', name: 'Work laptop', provider: 'iCloud Keychain', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, syncs: true }] });
    expect((await cli.run(['user', 'passkeys', 'remove', 'anna@acme.example', 'pk-1'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('--yes') });
    expect((await cli.run(['user', 'passkeys', 'remove', 'anna@acme.example', 'pk-1', '--dry-run'])).data).toMatchObject({ dryRun: true, passkey: { id: 'pk-1' } });
    expect(fake.userPasskeys(appId, 'user-1')).toHaveLength(1);
    const removed = await cli.run(['user', 'passkeys', 'remove', 'anna@acme.example', 'pk-1', '--yes']);
    expect(removed.data).toMatchObject({ removed: true, passkey: { id: 'pk-1', name: 'Work laptop' } });
    expect(last('DELETE', '/passkeys/pk-1')).toBeDefined();
    expect(fake.userPasskeys(appId, 'user-1')).toHaveLength(0);
    expect((await cli.run(['user', 'passkeys', 'remove', 'anna@acme.example', 'pk-1', '--yes'])).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['user', 'passkeys', 'list', 'nobody@acme.example'])).error).toMatchObject({ code: 'not-found' });
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

describe('email code or link, and MFA (TBP-70, TBP-848, TBP-869)', () => {
  it('shows and sets what emails carry: code or link', async () => {
    expect((await cli.run(['auth', 'email-confirmation'])).data).toEqual({ emailConfirmation: 'link' });
    const set = await cli.run(['auth', 'email-confirmation', 'code']);
    expect(set.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ emailConfirmation: 'code' });
    expect(set.data).toEqual({ emailConfirmation: 'code' });
    expect((await cli.run(['auth', 'config'])).data.emailConfirmation).toBe('code');
    expect((await cli.run(['auth', 'email-confirmation', 'pigeon'])).error).toMatchObject({ code: 'invalid' });
  });

  it('MFA is available: methods list shows it, and enable/disable mfa switch the app\'s second step', async () => {
    const listed = (await cli.run(['auth', 'methods', 'list'])).data.loginMethods.mfa;
    expect(listed).toMatchObject({ enabled: false, requiredIn: 'workspaces', methods: ['sms'], rememberDeviceDays: 0, note: expect.stringContaining('An authenticator app is the strongest choice.') });
    const on = await cli.run(['auth', 'methods', 'enable', 'mfa']);
    expect(on.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ secondStep: true });
    expect(on.data).toMatchObject({ method: 'mfa', enabled: true });
    expect((await cli.run(['auth', 'methods', 'disable', 'mfa'])).data).toMatchObject({ method: 'mfa', enabled: false });
  });

  it('mfa set: the ways as a whole set, the remembered days, on and off; never no way while on', async () => {
    const set = await cli.run(['auth', 'mfa', 'set', '--on', '--methods', 'totp,email', '--remember-days', '30']);
    expect(set.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ secondStep: true, mfa: { methods: { totp: true, email: true, sms: false }, rememberDeviceDays: 30 } });
    expect(set.data.mfa).toMatchObject({ enabled: true, methods: ['totp', 'email'], rememberDeviceDays: 30 });
    expect((await cli.run(['auth', 'mfa', 'show'])).data.mfa).toMatchObject({ requiredIn: 'workspaces', methods: ['totp', 'email'] });
    expect((await cli.run(['auth', 'mfa', 'set', '--methods', 'none'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('at least one way') });
    expect((await cli.run(['auth', 'mfa', 'set', '--methods', 'carrier-pigeon'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['auth', 'mfa', 'set', '--remember-days', '91'])).errors).not.toEqual([]);
    expect((await cli.run(['auth', 'mfa', 'set'])).error).toMatchObject({ code: 'invalid' });
    const email = await cli.run(['auth', 'mfa', 'set', '--methods', 'email']);
    expect(email.infos.join(' ')).toContain('An authenticator app is the strongest choice.');
  });

  it('texts refused by the plan are said as needing a plan that includes texts', async () => {
    await cli.run(['auth', 'mfa', 'set', '--methods', 'totp']);
    fake.refuseTexts();
    const refused = await cli.run(['auth', 'mfa', 'set', '--methods', 'totp,sms']);
    expect(refused.error).toMatchObject({ code: 'plan-required', message: expect.stringContaining('need a plan that includes texts') });
  });

  it('requiring MFA in every workspace runs the dry run with the change first, and needs --yes', async () => {
    await cli.run(['auth', 'mfa', 'set', '--on', '--methods', 'totp']);
    fake.setDryRun({ total: 3, mfaOn: true, ready: { count: 1, users: ['u1'] }, emailCode: { count: 0, users: [] }, setUp: { count: 1, users: ['u2'] }, lockedOut: { count: 1, users: ['u3'] }, notSignedUp: 0 });
    const asked = await cli.run(['auth', 'mfa', 'set', '--required-in', 'all']);
    expect(asked.error).toMatchObject({ code: 'invalid', message: expect.stringContaining('1 of 3 people would be locked out') });
    expect(fake.dryRuns().at(-1)).toEqual({ all: true, settings: { mfa: { requiredIn: 'all', methods: { totp: true, email: false, sms: false }, rememberDeviceDays: 0 } } });
    expect(last('PATCH', '/sign-in-settings')?.body).not.toEqual({ mfa: { requiredIn: 'all' } });
    const done = await cli.run(['auth', 'mfa', 'set', '--required-in', 'all', '--yes']);
    expect(done.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ mfa: { requiredIn: 'all' } });
    expect(done.data.mfa.requiredIn).toBe('all');
  });

  it('mfa dry-run: every person, one workspace\'s members, or named users; it changes nothing', async () => {
    fake.setDryRun({ total: 2, mfaOn: true, ready: { count: 1, users: ['u1'] }, emailCode: { count: 0, users: [] }, setUp: { count: 0, users: [] }, lockedOut: { count: 1, users: ['u2'] }, notSignedUp: 0 });
    const all = await cli.run(['auth', 'mfa', 'dry-run', '--all']);
    expect(all.data.dryRun).toEqual({ total: 2, mfaOn: true, alreadySetUp: 1, getEmailCode: 0, setUpAtNextSignIn: 0, notSignedUpYet: 0, lockedOut: 1, lockedOutUsers: ['u2'] });
    fake.addWorkspace(appId, { id: 'cust-1', name: 'Customer One' }, [{ id: 'mem-1', user: { id: 'u1', email: 'ann@customer.example' }, role: 'MEMBER' }, { id: 'mem-2', user: { id: 'u2', email: 'bo@customer.example' }, role: 'MEMBER' }]);
    await cli.run(['auth', 'mfa', 'dry-run', '--workspace', 'Customer One']);
    expect(fake.dryRuns().at(-1)).toMatchObject({ users: ['u1', 'u2'] });
    await cli.run(['auth', 'mfa', 'dry-run', '--users', 'u7, u8', '--methods', 'totp']);
    expect(fake.dryRuns().at(-1)).toEqual({ users: ['u7', 'u8'], settings: { mfa: { requiredIn: 'workspaces', methods: { totp: true, email: false, sms: false }, rememberDeviceDays: 0 } } });
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    expect((await cli.run(['auth', 'mfa', 'dry-run'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('password expiry and history (TBP-851)', () => {
  it('go with compliance or custom, say the server\'s warning, and another preset turns them off', async () => {
    expect((await cli.run(['auth', 'password-policy', '--expiry-days', '90'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('compliance or custom') });
    const set = await cli.run(['auth', 'password-policy', '--preset', 'compliance', '--expiry-days', '90', '--history', '5']);
    expect(set.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ password: { preset: 'compliance' }, passwordExpiryDays: 90, passwordHistory: 5 });
    expect(set.infos.join(' ')).toContain('advises against expiring passwords');
    expect(set.data).toMatchObject({ badge: 'Meets common audit checklists', passwordExpiryDays: 90, passwordHistory: 5, warning: expect.stringContaining('advises against') });
    const history = await cli.run(['auth', 'password-policy', '--history', 'off']);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ passwordHistory: 0 });
    expect(history.data.passwordHistory).toBe(0);
    const back = await cli.run(['auth', 'password-policy', '--preset', 'strict']);
    expect(back.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ password: { preset: 'strict' }, passwordExpiryDays: null });
    expect(back.infos.join(' ')).toContain('turns them off');
    expect((await cli.run(['auth', 'password-policy', '--expiry-days', '45'])).errors).not.toEqual([]);
    expect((await cli.run(['auth', 'password-policy', '--history', '25'])).errors).not.toEqual([]);
  });
});

describe('user mfa-reset (TBP-848)', () => {
  beforeEach(() => {
    fake.addUser(appId, { id: 'user-1', email: 'anna@acme.example' });
  });

  it('resets by id or email after --yes, says who first with --dry-run, and is also `users mfa-reset`', async () => {
    expect((await cli.run(['user', 'mfa-reset', 'user-1'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('--yes') });
    expect((await cli.run(['user', 'mfa-reset', 'anna@acme.example', '--dry-run'])).data).toMatchObject({ dryRun: true, user: { id: 'user-1', email: 'anna@acme.example' }, signsOut: true });
    expect(fake.secondStepResets()).toEqual([]);
    const reset = await cli.run(['users', 'mfa-reset', 'user-1', '--yes']);
    expect(reset.errors).toEqual([]);
    expect(reset.data).toMatchObject({ reset: true, user: { id: 'user-1' } });
    expect(last('POST', '/second-step/reset')?.path).toContain('/users/user-1/second-step/reset');
    expect(fake.secondStepResets()).toEqual(['user-1']);
    await cli.run(['user', 'mfa-reset', 'anna@acme.example', '--yes']);
    expect(fake.secondStepResets()).toEqual(['user-1', 'user-1']);
    expect((await cli.run(['user', 'mfa-reset', 'nobody', '--yes'])).error).toMatchObject({ code: 'not-found' });
  });
});
