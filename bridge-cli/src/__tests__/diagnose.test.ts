/**
 * `doctor` checks a project's settings against the app, `event auth-attempts` lists one person's sign-ins, `flag eval`
 * works out what a flag gives someone, and `flag init` sets a project up for flags.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originAllowed, parseEnv } from '../commands/diagnose.command';
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
let dir: string;
const last = (method: string, part: string) => fake.requests.filter((r) => r.method === method && r.path.includes(part)).pop();
const env = (lines: string[]) => writeFileSync(join(dir, '.env'), lines.join('\n') + '\n');

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  await cli.run(['app', 'use', appId]);
  dir = mkdtempSync(join(tmpdir(), 'bridge-project-'));
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('env files and origins', () => {
  it('parses NAME=value lines, quotes, comments and export', () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=v # note\n\nbad line')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'v' });
  });
  it('an origin is allowed exactly, by subdomain wildcard or by port wildcard', () => {
    expect(originAllowed(['https://app.example.com'], 'https://app.example.com')).toBe(true);
    expect(originAllowed(['https://*.example.com'], 'https://a.example.com')).toBe(true);
    expect(originAllowed(['https://*.example.com'], 'http://a.example.com')).toBe(false);
    expect(originAllowed(['http://localhost:*'], 'http://localhost:5173')).toBe(true);
    expect(originAllowed(['https://app.example.com'], 'https://evil.example.com')).toBe(false);
  });
});

describe('doctor', () => {
  it('lists every difference with its fix, never a secret value, and exits 1 on an error', async () => {
    const app = fake.apps.get(appId) as Record<string, unknown>;
    app['trust'] = { issuer: `${ISSUER}/apps/${appId}` };
    env(['PUBLIC_BRIDGE_ISSUER=https://other.example/identity-access/apps/x', 'VITE_BRIDGE_APP_ID=someone-else', 'VITE_BRIDGE_API_BASE_URL=https://elsewhere.example', 'VITE_BRIDGE_CALLBACK_URL=http://localhost:5173/auth/callback', 'VITE_BRIDGE_API_KEY=sk-very-secret']);
    const done = await cli.run(['doctor', '--dir', dir]);
    expect(done.exitCode).toBe(1);
    const codes = done.data.differences.map((each: { code: string }) => each.code);
    expect(codes).toEqual(expect.arrayContaining(['SECRET_IN_PUBLIC_VAR', 'ISSUER_MISMATCH', 'APP_ID_MISMATCH', 'BASE_URL_MISMATCH', 'CALLBACK_NOT_REGISTERED', 'ORIGIN_NOT_ALLOWED', 'NO_CALLBACK_URI']));
    expect(done.data.ok).toBe(false);
    expect(done.data.filesRead).toEqual([join(dir, '.env')]);
    expect(JSON.stringify(done.output)).not.toContain('sk-very-secret');
    const callback = done.data.differences.find((each: { code: string }) => each.code === 'CALLBACK_NOT_REGISTERED');
    expect(callback.fix).toContain('bridge app address add http://localhost:5173/auth/callback --use sign-in-return');
  });

  it('says ok when the project matches the app, and reads the framework from package.json', async () => {
    await cli.run(['app', 'address', 'add', 'http://localhost:5173/auth/callback', '--use', 'sign-in-return']);
    await cli.run(['app', 'address', 'add', 'http://localhost:5173', '--use', 'browser-origin']);
    await cli.run(['app', 'default-return', 'http://localhost:5173/auth/callback']);
    const issuer = `${ISSUER}/apps/${appId}`;
    (fake.apps.get(appId) as Record<string, unknown>)['trust'] = { issuer };
    env([`PUBLIC_BRIDGE_ISSUER=${issuer}`, 'VITE_BRIDGE_CALLBACK_URL=http://localhost:5173/auth/callback']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@nebulr-group/bridge-svelte': '1.0.0' } }));
    const done = await cli.run(['diagnose', '--dir', dir]);
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ ok: true, differences: [], framework: 'svelte' });
    expect(done.exitCode).toBe(0);
  });

  it('a missing variable the framework needs is named; an unreadable --env-file is refused', async () => {
    const done = await cli.run(['doctor', '--dir', dir, '--framework', 'nextjs']);
    expect(done.data.differences.map((each: { code: string }) => each.code)).toContain('MISSING_VAR');
    expect((await cli.run(['doctor', '--dir', dir, '--env-file', '.nope'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['doctor', '--framework', 'cobol'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('event auth-attempts', () => {
  it('lists the successes and the failures of one person, newest first, with the reason and the fix', async () => {
    fake.addUser?.(appId, { id: 'a'.repeat(24), email: 'pat@customer.example' });
    fake.addEvent(appId, { type: 'identity.sign_in_failed', data: { user: 'a'.repeat(24) } });
    fake.addEvent(appId, { type: 'identity.signed_in', userId: 'a'.repeat(24), workspaceId: 'cust-1', data: { methods: ['pwd'] } });
    const done = await cli.run(['event', 'auth-attempts', '--user', 'pat@customer.example']);
    expect(done.errors).toEqual([]);
    expect(done.data.user).toMatchObject({ exists: true, email: 'pat@customer.example' });
    expect(done.data.attempts.map((each: { outcome: string }) => each.outcome).sort()).toEqual(['failure', 'success']);
    expect(done.data.attempts.find((each: { outcome: string }) => each.outcome === 'failure')).toMatchObject({ reason: 'WRONG_PASSWORD', fix: expect.stringContaining('password reset') });
    expect(last('GET', '/users')?.query.get('email')).toBe('pat@customer.example');
    const byId = await cli.run(['event', 'auth-attempts', '--user', 'a'.repeat(24)]);
    expect(byId.data.user).toMatchObject({ exists: null, userId: 'a'.repeat(24) });
    const nobody = await cli.run(['event', 'auth-attempts', '--user', 'no@one.example']);
    expect(nobody.data.summary.note).toContain('No user with this email exists');
    expect((await cli.run(['event', 'auth-attempts', '--user', 'not an id'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('flag eval', () => {
  it('works out the value from the rule, the context and the identity, and says when the rule cannot run', async () => {
    await cli.run(['flag', 'create', 'beta-ui', '--when', 'user.role eq ADMIN']);
    await cli.run(['flag', 'on', 'beta-ui']);
    await cli.run(['flag', 'update', 'beta-ui', '--state', 'on-with-rule']);
    const admin = await cli.run(['flag', 'eval', 'beta-ui', '--context', '{"user.role":"ADMIN"}']);
    expect(admin.errors).toEqual([]);
    expect(admin.data).toMatchObject({ flag: 'beta-ui', enabled: true, value: true, result: { reason: 'TARGETING_MATCH', matched: true } });
    const other = await cli.run(['flag', 'eval', 'beta-ui', '--context', '{"user":{"role":"MEMBER"}}', '--identity', 'u-1']);
    expect(other.data).toMatchObject({ enabled: false, context: { identity: 'u-1' } });
    expect((await cli.run(['flag', 'eval', 'beta-ui', '--context', '[1]'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'eval', 'beta-ui', '--context', '{nope'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'eval', 'nobody'])).error).toMatchObject({ code: 'not-found' });
    await cli.run(['flag', 'off', 'beta-ui']);
    expect((await cli.run(['flag', 'eval', 'beta-ui'])).data).toMatchObject({ enabled: false, state: 'off' });
  });
});

describe('flag init', () => {
  it('finds the framework, writes the config, never overwrites one without --force, and says what to install and read', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@sveltejs/kit': '2', svelte: '5' } }));
    const done = await cli.run(['flag', 'init', '--cwd', dir]);
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ framework: 'svelte', app: { id: appId, name: 'Demo' }, install: { package: '@nebulr-group/bridge-svelte' } });
    expect(done.data.nextSteps[0]).toContain('bridge guide svelte feature-flags');
    const config = JSON.parse(readFileSync(join(dir, 'bridge-flags.config.json'), 'utf8'));
    expect(config).toMatchObject({ appId, appName: 'Demo', framework: 'svelte', provider: { mode: 'frontend' } });
    expect((await cli.run(['flag', 'init', '--cwd', dir])).error).toMatchObject({ code: 'conflict' });
    expect((await cli.run(['flag', 'init', '--cwd', dir, '--force', '--framework', 'nestjs'])).data.framework).toBe('nestjs');
    expect(JSON.parse(readFileSync(join(dir, 'bridge-flags.config.json'), 'utf8')).provider).toMatchObject({ mode: 'backend' });
    const empty = mkdtempSync(join(tmpdir(), 'bridge-empty-'));
    mkdirSync(empty, { recursive: true });
    expect((await cli.run(['flag', 'init', '--cwd', empty])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['flag', 'init', '--cwd', empty, '--no-config', '--framework', 'react'])).data.configFile).toBeNull();
  });
});
