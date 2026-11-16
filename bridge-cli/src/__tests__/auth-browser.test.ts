/**
 * `bridge auth login`: browser sign-in through Bridge's own sign-in page, on a
 * sign-in request. The CLI listens on 127.0.0.1, starts a request with its
 * PKCE challenge, the loopback address and a state, and opens the page with
 * the request's id; the page signs in on the request and sends the browser
 * back with the code; the CLI trades it with the verifier only it holds and
 * the same loopback address.
 */
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

/** The page the issuer publishes. */
const PAGE = 'https://bridge.test/sign-in/bridge-app/';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;

beforeEach(() => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  fake.setSignInPage(PAGE);
  cli = createCli(fake);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

/** Bridge's sign-in page, played by the test: signs in on the request it was opened with and sends the browser to its return. */
function signInPage(options: { tamper?: (url: URL) => void; seen?: URL[] } = {}) {
  return async (address: string) => {
    const url = new URL(address);
    options.seen?.push(url);
    const { code, redirectUri, state } = await fake.signInOn(url.searchParams.get('request') as string, { email: 'dev@example.com', password: 'correct horse' });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    back.searchParams.set('iss', ISSUER);
    options.tamper?.(back);
    // The browser follows the page's redirect to the loopback.
    setTimeout(() => void fetch(back).catch(() => undefined), 10);
    return { ok: true };
  };
}

const tokenCalls = () => fake.requests.filter((r) => r.path.endsWith('/token'));

describe('auth login (browser)', () => {
  it('starts a sign-in request for its loopback, opens the page with only the request, and trades the code with the same return', async () => {
    const seen: URL[] = [];
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }) });
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' } });
    expect(done.infos).toContain('Signing in at bridge.test for bridge.test.');

    const started = fake.requests.find((r) => r.path.endsWith('/sign-in-requests'));
    const asked = started?.body as Record<string, string>;
    expect(asked).toMatchObject({ code_challenge_method: 'S256', client_id: 'bridge-app' });
    expect(asked['code_challenge']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asked['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(asked['state'].length).toBeGreaterThanOrEqual(43);

    // The page's address carries the request's id and nothing of the sign-in: no challenge, return or state.
    const url = seen[0] as URL;
    expect(url.origin + url.pathname).toBe(PAGE);
    expect([...url.searchParams.keys()]).toEqual(['request']);
    expect(fake.signInRequests.has(url.searchParams.get('request') as string)).toBe(true);

    expect(tokenCalls().map((r) => r.body)).toEqual([
      { grant_type: 'authorization_code', code: expect.any(String), code_verifier: expect.any(String), client_id: 'bridge-app', redirect_uri: asked['redirect_uri'] },
    ]);
  });

  it('opens a sign-in page on another address than the issuer, such as the dashboard, and says where it signs in', async () => {
    const dashboard = 'https://app.bridge.test/connect/';
    fake.setSignInPage(dashboard);
    const seen: URL[] = [];
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }) });
    expect(done.errors).toEqual([]);
    expect(done.infos).toContain('Signing in at app.bridge.test for bridge.test.');
    expect(done.infos.join('\n')).toContain('approve the sign-in there');
    expect((seen[0] as URL).origin + (seen[0] as URL).pathname).toBe(dashboard);
    expect([...(seen[0] as URL).searchParams.keys()]).toEqual(['request']);
    expect(done.data).toMatchObject({ issuer: ISSUER, user: { email: 'dev@example.com' } });
  });

  it('prints the address when the browser cannot be opened', async () => {
    const open = signInPage();
    const done = await cli.run(['auth', 'login'], {
      openBrowser: async (url) => {
        await open(url);
        return { ok: false };
      },
    });
    expect(done.errors).toEqual([]);
    expect(done.infos.join('\n')).toContain(`Open this address in your browser to sign in, and approve the sign-in there:\n  ${PAGE}?request=`);
  });

  it('refuses a callback whose state is not its own', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('state', 'forged-state-value') }) });
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(String(done.error?.['message'])).toContain('State mismatch');
    expect(tokenCalls()).toEqual([]);
  });

  it('refuses a code from another issuer (RFC 9207)', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('iss', 'https://evil.test/identity-access/apps/x') }) });
    expect(String(done.error?.['message'])).toContain('another issuer');
    expect(tokenCalls()).toEqual([]);
  });

  it('refuses a callback that does not name its issuer (RFC 9207)', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.delete('iss') }) });
    expect(String(done.error?.['message'])).toContain('does not name its issuer');
    expect(tokenCalls()).toEqual([]);
  });

  it('reports a cancelled sign-in', async () => {
    const done = await cli.run(['auth', 'login'], {
      openBrowser: async () => {
        const [request] = [...fake.signInRequests.values()];
        const back = new URL(request?.redirectUri as string);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', request?.state as string);
        setTimeout(() => void fetch(back).catch(() => undefined), 10);
        return { ok: true };
      },
    });
    expect(done.error).toMatchObject({ code: 'cancelled', message: 'Sign-in cancelled.' });
  });

  it('without a sign-in page and its requests, says to sign in with --password, and opens nothing', async () => {
    fake.setSignInPage(null);
    const seen: URL[] = [];
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }) });
    expect(done.error).toMatchObject({ code: 'not-offered' });
    expect(String(done.error?.['hint'])).toContain('--password');
    expect(seen).toEqual([]);
    expect(fake.requests.some((r) => r.path.endsWith('/sign-in-requests'))).toBe(false);
  });

  it('no longer takes a sign-in page of its own: --sign-in-page is gone', async () => {
    const done = await cli.run(['auth', 'login', '--sign-in-page', 'https://evil.example/cli'], { openBrowser: signInPage() });
    expect(done.exitCode).not.toBe(0);
    expect(fake.requests.some((r) => r.path.endsWith('/sign-in-requests'))).toBe(false);
  });
});

describe('the server address', () => {
  /** The tests' CLI has BRIDGE_ISSUER set; these runs clear it. */
  const NO_ISSUER = { BRIDGE_ISSUER: '' };

  it('--server finds the Bridge App\'s issuer at the server, signs in to it, and saves it', async () => {
    const done = await cli.run(['--server', 'https://bridge.test', 'auth', 'login'], { openBrowser: signInPage(), env: NO_ISSUER });
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ issuer: ISSUER });
    expect(fake.requests.some((r) => r.path === '/.well-known/oauth-protected-resource')).toBe(true);
    // Saved: the next command needs neither --server nor --issuer.
    const who = await cli.run(['auth', 'whoami'], { env: NO_ISSUER });
    expect(who.errors).toEqual([]);
    expect(who.data).toMatchObject({ issuer: ISSUER });
  });

  it('BRIDGE_SERVER does the same, and --issuer or BRIDGE_ISSUER wins over it', async () => {
    expect((await cli.run(['auth', 'login'], { openBrowser: signInPage(), env: { ...NO_ISSUER, BRIDGE_SERVER: 'https://bridge.test/' } })).data).toMatchObject({ issuer: ISSUER });
    const reads = () => fake.requests.filter((r) => r.path === '/.well-known/oauth-protected-resource').length;
    const before = reads();
    expect((await cli.run(['auth', 'login'], { openBrowser: signInPage(), env: { BRIDGE_SERVER: 'https://bridge.test', BRIDGE_ISSUER: ISSUER } })).errors).toEqual([]);
    expect(reads()).toBe(before);
  });

  it('refuses an issuer the server names on another address, and a server that is not https', async () => {
    fake.setProtectedResourceIssuer('https://evil.test/identity-access/apps/bridge-app');
    const elsewhere = await cli.run(['--server', 'https://bridge.test', 'auth', 'login'], { openBrowser: signInPage(), env: NO_ISSUER });
    expect(elsewhere.error).toMatchObject({ code: 'misconfigured' });
    expect(String(elsewhere.error?.['message'])).toContain('another address');
    const plain = await cli.run(['--server', 'http://bridge.test', 'auth', 'login'], { openBrowser: signInPage(), env: NO_ISSUER });
    expect(plain.error).toMatchObject({ code: 'misconfigured' });
    expect(fake.requests.some((r) => r.path.endsWith('/sign-in-requests'))).toBe(false);
  });

  it('with no server, issuer or saved sign-in, says to pass --server', async () => {
    const done = await cli.run(['auth', 'login'], { env: NO_ISSUER });
    expect(done.error).toMatchObject({ code: 'misconfigured' });
    expect(String(done.error?.['hint'])).toContain('--server');
  });
});
