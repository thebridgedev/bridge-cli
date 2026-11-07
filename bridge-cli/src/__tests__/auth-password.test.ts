/**
 * `bridge auth login --password`: email and password in the terminal against
 * the Bridge App's challenge endpoint, the workspace step, the code traded
 * with PKCE, and then the session: kept in a 0600 file, renewed with
 * rotation, ended by revoking the refresh token.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;

beforeEach(() => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  fake.addPerson({ email: 'two@example.com', password: 'pw-two-workspaces', workspaces: [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }] });
  cli = createCli(fake);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

const sessionsFile = () => join(cli.dir, 'sessions.json');

describe('auth login --password', () => {
  it('signs in with one workspace, trades the code with its verifier, and keeps the session in a 0600 file', async () => {
    const done = await cli.signIn();
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' } });
    expect(done.infos).toContain('Signed in as dev@example.com.');

    const challenge = fake.requests.find((r) => r.path.endsWith('/sign-in'));
    expect(challenge?.body).toMatchObject({ email: 'dev@example.com', code_challenge_method: 'S256', client_id: 'bridge-app' });
    const exchange = fake.requests.find((r) => r.path.endsWith('/token'));
    expect(exchange?.body).toMatchObject({ grant_type: 'authorization_code', client_id: 'bridge-app' });
    expect(typeof (exchange?.body as Record<string, unknown>)['code_verifier']).toBe('string');

    expect(statSync(sessionsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(cli.dir).mode & 0o077).toBe(0);
    const stored = JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER];
    expect(stored).toMatchObject({ issuer: ISSUER, appId: 'bridge-app', workspace: 'ws-1' });
    expect(stored.refreshToken).toMatch(/^rt-/);
    // The password is never kept.
    expect(readFileSync(sessionsFile(), 'utf8')).not.toContain('correct horse');
    // The issuer is saved for the commands that follow.
    expect(JSON.parse(readFileSync(join(cli.dir, 'config.json'), 'utf8')).issuer).toBe(ISSUER);
  });

  it('asks which workspace when the person has several, and goes on with the flow', async () => {
    const done = await cli.run(['auth', 'login', '--password', '--email', 'two@example.com', '--password-stdin'], {
      stdin: 'pw-two-workspaces\n',
      interactive: true,
      answers: ['2'],
    });
    expect(done.errors).toEqual([]);
    expect(done.data.workspace).toBe('ws-b');
    expect(done.infos.join('\n')).toContain('1. Alpha (ws-a)');
    const steps = fake.requests.filter((r) => r.path.endsWith('/sign-in'));
    expect(steps).toHaveLength(2);
    expect(steps[1]?.body).toMatchObject({ workspace: 'ws-b' });
    expect(Object.keys(steps[1]?.body as object).sort()).toEqual(['client_id', 'flow', 'workspace']);
  });

  it('with nobody to ask, lists the workspaces and says to name one', async () => {
    const done = await cli.run(['auth', 'login', '--password', '--email', 'two@example.com', '--password-stdin'], { stdin: 'pw-two-workspaces' });
    expect(done.exitCode).toBe(1);
    expect(done.error).toMatchObject({ code: 'invalid', details: [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }] });
    expect(String(done.error?.['message'])).toContain('--workspace');
  });

  it('takes --workspace up front, with no workspace step', async () => {
    const done = await cli.run(['auth', 'login', '--password', '--email', 'two@example.com', '--password-stdin', '--workspace', 'ws-a'], { stdin: 'pw-two-workspaces' });
    expect(done.data.workspace).toBe('ws-a');
    expect(fake.requests.filter((r) => r.path.endsWith('/sign-in'))).toHaveLength(1);
  });

  it('says so on a wrong password, and keeps nothing', async () => {
    const done = await cli.run(['auth', 'login', '--password', '--email', 'dev@example.com', '--password-stdin'], { stdin: 'nope' });
    expect(done.error).toMatchObject({ code: 'wrong-credentials', status: 400 });
    expect(() => statSync(sessionsFile())).toThrow();
  });

  it('asks for the password without echo in a terminal', async () => {
    const done = await cli.run(['auth', 'login', '--password'], { interactive: true, answers: ['dev@example.com', 'correct horse'] });
    expect(done.errors).toEqual([]);
    expect(done.data.user.email).toBe('dev@example.com');
  });

  it('needs an issuer', async () => {
    const done = await cli.run(['auth', 'login', '--password'], { env: { BRIDGE_ISSUER: '' } });
    expect(done.error).toMatchObject({ code: 'misconfigured', message: 'No issuer is set.' });
    expect(done.exitCode).toBe(3);
  });

  it('refuses an http issuer that is not on this machine', async () => {
    const done = await cli.run(['auth', 'login', '--password', '--issuer', 'http://bridge.example.com/identity-access/apps/x']);
    expect(done.error).toMatchObject({ code: 'misconfigured' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('the session', () => {
  it('whoami reads the person from /v2/accounts/me', async () => {
    await cli.signIn();
    const done = await cli.run(['auth', 'whoami']);
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' }, tokenStore: expect.stringContaining('file') });
    const me = fake.requests.filter((r) => r.path === '/v2/accounts/me').pop();
    expect(me?.headers['authorization']).toMatch(/^Bearer at-/);
  });

  it('renews an access token about to expire, with rotation: the new refresh token replaces the spent one', async () => {
    await cli.signIn();
    const before = JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER];
    fake.advance(290_000);
    const done = await cli.run(['auth', 'whoami']);
    expect(done.errors).toEqual([]);
    const after = JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER];
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    const renewal = fake.requests.find((r) => (r.body as Record<string, unknown> | undefined)?.['grant_type'] === 'refresh_token');
    expect(renewal?.body).toMatchObject({ refresh_token: before.refreshToken, client_id: 'bridge-app' });
    // A second renewal uses the new token, not the spent one.
    fake.advance(290_000);
    expect((await cli.run(['auth', 'whoami'])).errors).toEqual([]);
  });

  it('renews once and retries when Bridge refuses the token', async () => {
    await cli.signIn();
    // The CLI thinks its token is good; Bridge no longer takes it.
    const stored = JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER];
    fake.dropAccessTokens();
    const done = await cli.run(['auth', 'whoami']);
    expect(done.errors).toEqual([]);
    expect(JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER].refreshToken).not.toBe(stored.refreshToken);
    const me = fake.requests.filter((r) => r.path === '/v2/accounts/me');
    expect(me.slice(-2).map((r) => r.headers['authorization'] === `Bearer ${stored.accessToken}`)).toEqual([true, false]);
  });

  it('a session Bridge ended is forgotten, with the way back', async () => {
    await cli.signIn();
    for (const session of fake.sessions.values()) session.ended = true;
    fake.advance(301_000);
    const done = await cli.run(['auth', 'whoami']);
    expect(done.error).toMatchObject({ code: 'session-ended' });
    expect(String(done.error?.['hint'])).toContain('bridge auth login');
    expect(done.exitCode).toBe(3);
    expect((await cli.run(['auth', 'whoami'])).error).toMatchObject({ code: 'not-signed-in' });
  });

  it('switches workspace by renewal', async () => {
    await cli.run(['auth', 'login', '--password', '--email', 'two@example.com', '--password-stdin', '--workspace', 'ws-a'], { stdin: 'pw-two-workspaces' });
    const list = await cli.run(['auth', 'workspace']);
    expect(list.data).toEqual([expect.objectContaining({ id: 'ws-a', current: true }), expect.objectContaining({ id: 'ws-b', current: false })]);
    const done = await cli.run(['auth', 'workspace', 'ws-b']);
    expect(done.data).toEqual({ issuer: ISSUER, workspace: 'ws-b' });
    expect(fake.requests.pop()?.body).toMatchObject({ grant_type: 'refresh_token', workspace: 'ws-b' });
  });

  it('logout revokes the refresh token and removes the session', async () => {
    await cli.signIn();
    const stored = JSON.parse(readFileSync(sessionsFile(), 'utf8'))[ISSUER];
    const done = await cli.run(['auth', 'logout']);
    expect(done.data).toEqual({ issuer: ISSUER, signedOut: true, revoked: true });
    expect(fake.revoked).toEqual([stored.refreshToken]);
    expect(fake.requests.pop()?.body).toEqual({ token: stored.refreshToken, token_type_hint: 'refresh_token', client_id: 'bridge-app' });
    expect((await cli.run(['auth', 'whoami'])).error).toMatchObject({ code: 'not-signed-in' });
  });

  it('logout forgets the session here even when Bridge cannot be reached', async () => {
    await cli.signIn();
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    const done = await cli.run(['auth', 'logout'], { fetch: offline });
    expect(done.data).toEqual({ issuer: ISSUER, signedOut: true, revoked: false });
    expect(done.infos.join('\n')).toContain('Bridge could not be told');
    expect((await cli.run(['auth', 'whoami'])).error).toMatchObject({ code: 'not-signed-in' });
  });
});
