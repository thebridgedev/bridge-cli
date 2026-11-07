/**
 * `bridge auth login`: browser sign-in through Bridge's own sign-in page in
 * hand-off mode. The CLI listens on 127.0.0.1, opens the page with its PKCE
 * challenge, the loopback address and a state; the page signs in with that
 * challenge and sends the browser back with the code; the CLI trades it at
 * the issuer's token endpoint with the verifier only it holds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

/** The page the issuer publishes. */
const PAGE = 'https://signin.bridge.test/cli';

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

/** Bridge's sign-in page, played by the test: signs in with the challenge it was given and returns to the loopback. */
function signInPage(options: { tamper?: (url: URL) => void; seen?: URL[] } = {}) {
  return async (address: string) => {
    const url = new URL(address);
    options.seen?.push(url);
    const code = await fake.handoff(url.searchParams, { email: 'dev@example.com', password: 'correct horse' });
    const back = new URL(url.searchParams.get('redirect_uri') as string);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') as string);
    back.searchParams.set('iss', ISSUER);
    options.tamper?.(back);
    // The browser follows the page's redirect to the loopback.
    setTimeout(() => void fetch(back).catch(() => undefined), 10);
    return { ok: true };
  };
}

describe('auth login (browser)', () => {
  it('opens the sign-in page in hand-off mode and trades the code it gets back', async () => {
    const seen: URL[] = [];
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }) });
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' } });
    expect(done.infos).toContain('Signing in at signin.bridge.test for bridge.test.');

    const url = seen[0] as URL;
    expect(url.origin + url.pathname).toBe(PAGE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('bridge-app');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((url.searchParams.get('state') ?? '').length).toBeGreaterThanOrEqual(43);

    const exchange = fake.requests.find((r) => r.path.endsWith('/token'));
    expect(exchange?.body).toMatchObject({ grant_type: 'authorization_code', client_id: 'bridge-app' });
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
    expect(done.infos.join('\n')).toContain(`Open this address in your browser to sign in:\n  ${PAGE}?`);
  });

  it('refuses a callback whose state is not its own', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('state', 'forged-state-value') }) });
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(String(done.error?.['message'])).toContain('State mismatch');
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('refuses a code from another issuer (RFC 9207)', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('iss', 'https://evil.test/identity-access/apps/x') }) });
    expect(String(done.error?.['message'])).toContain('another issuer');
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('refuses a callback that does not name its issuer (RFC 9207)', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: signInPage({ tamper: (back) => back.searchParams.delete('iss') }) });
    expect(String(done.error?.['message'])).toContain('does not name its issuer');
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('reports a cancelled sign-in', async () => {
    const done = await cli.run(['auth', 'login'], {
      openBrowser: async (address) => {
        const url = new URL(address);
        const back = new URL(url.searchParams.get('redirect_uri') as string);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', url.searchParams.get('state') as string);
        setTimeout(() => void fetch(back).catch(() => undefined), 10);
        return { ok: true };
      },
    });
    expect(done.error).toMatchObject({ code: 'cancelled', message: 'Sign-in cancelled.' });
  });

  it('without a sign-in page, says to sign in with --password', async () => {
    fake.setSignInPage(null);
    const done = await cli.run(['auth', 'login']);
    expect(done.error).toMatchObject({ code: 'not-offered' });
    expect(String(done.error?.['hint'])).toContain('--password');
  });
});

describe('which sign-in page', () => {
  it('the page the issuer publishes wins over --sign-in-page and BRIDGE_SIGN_IN_PAGE', async () => {
    const seen: URL[] = [];
    const done = await cli.run(['auth', 'login', '--sign-in-page', 'https://bridge-signin.example/cli'], {
      openBrowser: signInPage({ seen }),
      env: { BRIDGE_SIGN_IN_PAGE: 'https://other.example/cli' },
    });
    expect(done.errors).toEqual([]);
    expect(seen.map((url) => url.origin)).toEqual(['https://signin.bridge.test']);
    expect(done.infos).toContain('Using the sign-in page bridge.test publishes, not https://bridge-signin.example/cli.');
    const env = await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }), env: { BRIDGE_SIGN_IN_PAGE: 'https://other.example/cli' } });
    expect(env.errors).toEqual([]);
    expect(seen.map((url) => url.origin)).toEqual(['https://signin.bridge.test', 'https://signin.bridge.test']);
  });

  it('with none published, an override on another origin is refused before any browser opens', async () => {
    fake.setSignInPage(null);
    const seen: URL[] = [];
    for (const run of [
      () => cli.run(['auth', 'login', '--sign-in-page', 'https://bridge-signin.example/cli'], { openBrowser: signInPage({ seen }) }),
      () => cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }), env: { BRIDGE_SIGN_IN_PAGE: 'https://bridge-signin.example/cli' } }),
    ]) {
      const done = await run();
      expect(done.error).toMatchObject({ code: 'misconfigured' });
      expect(String(done.error?.['message'])).toContain("only on the issuer's own address (https://bridge.test)");
    }
    expect(seen).toEqual([]);
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('with none published, an override on the issuer\'s origin or on localhost is used, and never saved', async () => {
    fake.setSignInPage(null);
    const seen: URL[] = [];
    expect((await cli.run(['auth', 'login', '--sign-in-page', 'https://bridge.test/cli-sign-in'], { openBrowser: signInPage({ seen }) })).errors).toEqual([]);
    expect((await cli.run(['auth', 'login'], { openBrowser: signInPage({ seen }), env: { BRIDGE_SIGN_IN_PAGE: 'http://localhost:5173/sign-in' } })).errors).toEqual([]);
    expect((await cli.run(['auth', 'login', '--sign-in-page', 'http://127.0.0.1:5173/sign-in'], { openBrowser: signInPage({ seen }) })).errors).toEqual([]);
    expect(seen.map((url) => url.origin)).toEqual(['https://bridge.test', 'http://localhost:5173', 'http://127.0.0.1:5173']);
    const config = join(cli.dir, 'config.json');
    expect(existsSync(config) ? readFileSync(config, 'utf8') : '').not.toMatch(/sign-in|signInPage|5173/i);
    expect((await cli.run(['auth', 'login'])).error).toMatchObject({ code: 'not-offered' });
  });

  it('refuses a sign-in page that is not https', async () => {
    fake.setSignInPage(null);
    const done = await cli.run(['auth', 'login', '--sign-in-page', 'http://bridge.test/cli']);
    expect(done.error).toMatchObject({ code: 'misconfigured' });
  });
});
