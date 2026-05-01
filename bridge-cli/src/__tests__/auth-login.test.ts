// `@nebulr-group/bridge-auth-core` is ESM-only; jest can't import it under the
// CJS transformer. Mock it virtually — the login command path doesn't use it
// directly, but `config.ts` (imported transitively) does.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({ __esModule: true, BridgeManagement: jest.fn() }),
  { virtual: true },
);

/**
 * TBP-113 — `bridge auth login` integration test.
 *
 * Drives the full login flow with browser-open mocked and `fetch` stubbed for
 * `/v1/auth/cli/token`:
 *
 *  1. Run `bridge auth login --no-browser` so the URL is printed to stdout
 *     instead of triggering a real `open`/`xdg-open` shell-out.
 *  2. Parse the printed URL to extract the loopback redirect.
 *  3. Hit the loopback like a real browser would (HTTP GET with `code` and
 *     `state`).
 *  4. Stub fetch so the token-exchange returns a predictable response.
 *  5. Assert that the credentials file is written with mode 0600 and contains
 *     the expected fields.
 */
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialsPath } from '../credentials';
import { registerAuthLoginCommand } from '../commands/auth/login.command';

const ORIGINAL_ENV = process.env;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-login-test-'));
}

function extractRedirectUriFromAuthorizeUrl(stdout: string): string {
  // `bridge auth login --no-browser` prints "Open this URL ... <url>".
  const match = stdout.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
  if (!match) throw new Error(`No authorize URL found in:\n${stdout}`);
  const url = new URL(match[0]);
  const redirect = url.searchParams.get('redirect');
  if (!redirect) throw new Error('Authorize URL has no `redirect` parameter');
  return redirect;
}

function extractStateFromAuthorizeUrl(stdout: string): string {
  const match = stdout.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
  if (!match) throw new Error('No authorize URL found in stdout');
  const url = new URL(match[0]);
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Authorize URL has no `state` parameter');
  return state;
}

async function hitLoopback(redirectUri: string, code: string, state: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const target = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const req = http.get(target, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}

describe('bridge auth login', () => {
  let tmpHome: string;
  let fetchSpy: jest.SpyInstance;
  let stdoutChunks: string[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    tmpHome = freshTmpHome();
    process.env.HOME = tmpHome;
    // Point both URLs at example hosts so we never accidentally hit prod.
    process.env.BRIDGE_BASE_URL = 'https://api.example.com';
    process.env.BRIDGE_AUTH_BASE_URL = 'https://auth.example.com';

    stdoutChunks = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
  });

  it('completes the full PKCE flow and writes a 0600 credentials file', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          api_token: 'fake-jwt-login',
          expires_at: '2099-01-01T00:00:00.000Z',
          app: { id: 'app-99', name: 'Test App' },
          user: { id: 'user-99', email: 'login@acme.com' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const program = new Command();
    program.exitOverride();
    const auth = program.command('auth');
    registerAuthLoginCommand(auth);

    // Kick off `auth login --no-browser`. It will print the authorize URL to
    // stdout, then block on the loopback. We hit the loopback ourselves a
    // moment later to drive the flow forward.
    let runError: unknown;
    const runPromise = program
      .parseAsync(['node', 'bridge', 'auth', 'login', '--no-browser'])
      .catch((err) => {
        runError = err;
      });

    // Wait for the loopback URL to appear in stdout. Poll briefly.
    const deadline = Date.now() + 5000;
    let redirectUri = '';
    let state = '';
    while (Date.now() < deadline) {
      const stdout = stdoutChunks.join('');
      try {
        redirectUri = extractRedirectUriFromAuthorizeUrl(stdout);
        state = extractStateFromAuthorizeUrl(stdout);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (!redirectUri) {
      throw new Error(
        `redirectUri not seen in stdout. runError=${runError ?? '<none>'} stdout=<<<${stdoutChunks.join('')}>>>`,
      );
    }
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(state.length).toBeGreaterThanOrEqual(43);

    // Drive the loopback callback like the browser would.
    await hitLoopback(redirectUri, 'AUTH-CODE', state);

    // Now the login command should finish.
    await runPromise;

    // Assert: token-exchange was POSTed correctly.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/auth/cli/token');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.code).toBe('AUTH-CODE');
    expect(typeof body.code_verifier).toBe('string');
    expect(body.code_verifier.length).toBeGreaterThanOrEqual(43);

    // Assert: credentials file written with the expected shape.
    const filePath = credentialsPath();
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    if (process.platform !== 'win32') {
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written.apiKey).toBe('fake-jwt-login');
    expect(written.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(written.app).toEqual({ id: 'app-99', name: 'Test App' });
    expect(written.user).toEqual({ id: 'user-99', email: 'login@acme.com' });
    expect(written.baseUrl).toBe('https://api.example.com');
    expect(typeof written.issuedAt).toBe('string');

    // Assert: confirmation line printed.
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('Logged in as login@acme.com');
    expect(stdout).toContain('App: Test App');
  }, 15_000);

  it('adds prompt=login to the authorize URL when --reauth is set', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          api_token: 'fake-jwt-reauth',
          expires_at: '2099-01-01T00:00:00.000Z',
          app: { id: 'a', name: 'A' },
          user: { id: 'u', email: 'u@a.b' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const program = new Command();
    program.exitOverride();
    const auth = program.command('auth');
    registerAuthLoginCommand(auth);

    const runPromise = program.parseAsync([
      'node',
      'bridge',
      'auth',
      'login',
      '--no-browser',
      '--reauth',
    ]);

    const deadline = Date.now() + 5000;
    let redirect = '';
    let state = '';
    let authorizeUrl = '';
    while (Date.now() < deadline) {
      const stdout = stdoutChunks.join('');
      const match = stdout.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
      if (match) {
        authorizeUrl = match[0];
        const u = new URL(authorizeUrl);
        redirect = u.searchParams.get('redirect') ?? '';
        state = u.searchParams.get('state') ?? '';
        if (redirect && state) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('prompt')).toBe('login');

    await hitLoopback(redirect, 'AUTH-CODE-REAUTH', state);
    await runPromise;
  }, 15_000);

  it('omits the prompt param when --reauth is not set', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          api_token: 'fake-jwt-noflag',
          expires_at: '2099-01-01T00:00:00.000Z',
          app: { id: 'a', name: 'A' },
          user: { id: 'u', email: 'u@a.b' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const program = new Command();
    program.exitOverride();
    const auth = program.command('auth');
    registerAuthLoginCommand(auth);

    const runPromise = program.parseAsync(['node', 'bridge', 'auth', 'login', '--no-browser']);

    const deadline = Date.now() + 5000;
    let redirect = '';
    let state = '';
    let authorizeUrl = '';
    while (Date.now() < deadline) {
      const stdout = stdoutChunks.join('');
      const match = stdout.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
      if (match) {
        authorizeUrl = match[0];
        const u = new URL(authorizeUrl);
        redirect = u.searchParams.get('redirect') ?? '';
        state = u.searchParams.get('state') ?? '';
        if (redirect && state) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('prompt')).toBeNull();

    await hitLoopback(redirect, 'AUTH-CODE-NOFLAG', state);
    await runPromise;
  }, 15_000);

  it('builds the authorize URL with --app and --label flags', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          api_token: 'fake-jwt-flagged',
          expires_at: '2099-01-01T00:00:00.000Z',
          app: { id: 'a', name: 'A' },
          user: { id: 'u', email: 'u@a.b' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const program = new Command();
    program.exitOverride();
    const auth = program.command('auth');
    registerAuthLoginCommand(auth);

    const runPromise = program.parseAsync([
      'node',
      'bridge',
      'auth',
      'login',
      '--no-browser',
      '--app',
      'acme',
      '--label',
      'work laptop',
    ]);

    // Wait for the URL.
    const deadline = Date.now() + 5000;
    let redirect = '';
    let state = '';
    let authorizeUrl = '';
    while (Date.now() < deadline) {
      const stdout = stdoutChunks.join('');
      const match = stdout.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
      if (match) {
        authorizeUrl = match[0];
        const u = new URL(authorizeUrl);
        redirect = u.searchParams.get('redirect') ?? '';
        state = u.searchParams.get('state') ?? '';
        if (redirect && state) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('app_id')).toBe('acme');
    expect(u.searchParams.get('label')).toBe('work laptop');
    expect(u.searchParams.get('scope')).toBe('management');
    expect(u.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Finish the flow so the test doesn't leak a listening port.
    await hitLoopback(redirect, 'AUTH-CODE-2', state);
    await runPromise;
  }, 15_000);
});
