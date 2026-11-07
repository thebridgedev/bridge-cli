/**
 * `bridge auth login`: browser sign-in through Bridge's own sign-in page in
 * hand-off mode. The CLI listens on 127.0.0.1, opens the page with its PKCE
 * challenge, the loopback address and a state; the page signs in with that
 * challenge and sends the browser back with the code; the CLI trades it at
 * the issuer's token endpoint with the verifier only it holds.
 */
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

const PAGE = 'https://signin.bridge.test/cli';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;

beforeEach(() => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
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
    const done = await cli.run(['auth', 'login', '--sign-in-page', PAGE], { openBrowser: signInPage({ seen }) });
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' } });

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
    // The page's address is saved for next time.
    expect((await cli.run(['auth', 'login'], { openBrowser: signInPage() })).errors).toEqual([]);
  });

  it('prints the address when the browser cannot be opened', async () => {
    const open = signInPage();
    const done = await cli.run(['auth', 'login', '--sign-in-page', PAGE], {
      openBrowser: async (url) => {
        await open(url);
        return { ok: false };
      },
    });
    expect(done.errors).toEqual([]);
    expect(done.infos.join('\n')).toContain(`Open this address in your browser to sign in:\n  ${PAGE}?`);
  });

  it('refuses a callback whose state is not its own', async () => {
    const done = await cli.run(['auth', 'login', '--sign-in-page', PAGE], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('state', 'forged-state-value') }) });
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(String(done.error?.['message'])).toContain('State mismatch');
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('refuses a code from another issuer (RFC 9207)', async () => {
    const done = await cli.run(['auth', 'login', '--sign-in-page', PAGE], { openBrowser: signInPage({ tamper: (back) => back.searchParams.set('iss', 'https://evil.test/identity-access/apps/x') }) });
    expect(String(done.error?.['message'])).toContain('another issuer');
    expect(fake.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
  });

  it('reports a cancelled sign-in', async () => {
    const done = await cli.run(['auth', 'login', '--sign-in-page', PAGE], {
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
    const done = await cli.run(['auth', 'login']);
    expect(done.error).toMatchObject({ code: 'not-offered' });
    expect(String(done.error?.['hint'])).toContain('--password');
  });

  it('refuses a sign-in page that is not https', async () => {
    const done = await cli.run(['auth', 'login', '--sign-in-page', 'http://signin.example.com/cli']);
    expect(done.error).toMatchObject({ code: 'misconfigured' });
  });
});
