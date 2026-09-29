/**
 * TBP-769 — one `bridge auth login` covers every app of the workspace, like the
 * MCP server: `app list|use|create`, a global `--app`, and the per-app token
 * swap on the execution path.
 *
 * Drives the REAL command tree (`registerGlobalOptions` + `registerCommands`)
 * so the `--app` collision with `auth login --app` is exercised as a user
 * would hit it. HTTP is `fetch`, stubbed per route; the management SDK is a
 * mock that records the apiKey each client was built with — that is the
 * behaviour under test: which token a command actually acts with.
 */
const ManagementMock = jest.fn();
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: ManagementMock,
  ManagementHttpClient: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readCredentialsFile,
  writeCredentials,
  type StoredCredentials,
} from '../credentials';
import { registerCommands, registerGlobalOptions } from '../program';
import { resetAppContext, resetManagementClient, setProfileOverride } from '../config';

const ORIGINAL_ENV = process.env;
const HOME_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const STAGE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DUP1_ID = 'cccccccccccccccccccccccc';
const DUP2_ID = 'dddddddddddddddddddddddd';
const BASE = 'https://api.example.com';

function creds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    apiKey: 'login-token',
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: HOME_ID, name: 'Acme' },
    user: { id: 'u1', email: 'dev@acme.com' },
    baseUrl: BASE,
    appAccess: 'workspace',
    ...overrides,
  };
}

const APPS = {
  scope: 'workspace',
  homeAppId: HOME_ID,
  apps: [
    { id: HOME_ID, name: 'Acme', home: true },
    { id: STAGE_ID, name: 'Acme Stage', home: false },
    { id: DUP1_ID, name: 'Twin', home: false },
    { id: DUP2_ID, name: 'Twin', home: false },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Route = (url: string, init: RequestInit) => Response | undefined;
let routes: Route[];
let fetchSpy: jest.SpyInstance;
let appGet: jest.Mock;
let tmpHome: string;

function defaultRoutes(): Route[] {
  return [
    (url, init) =>
      url === `${BASE}/v1/cli/workspace/apps` && init.method === 'GET' ? json(APPS) : undefined,
    (url, init) => {
      const m = /\/v1\/cli\/workspace\/apps\/([^/]+)\/token$/.exec(url);
      if (!m || init.method !== 'POST') return undefined;
      const app = APPS.apps.find((a) => a.id === m[1]);
      if (!app) return json({ code: 'INVALID_APP', message: 'Not an app id.', fix: 'Use `bridge app list`.' }, 400);
      return json({
        // Like the server: the home app answers with the login token itself.
        apiKey: app.id === HOME_ID ? 'login-token' : `app-token-${app.id}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        app: { id: app.id, name: app.name },
      });
    },
  ];
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const k of ['BRIDGE_API_KEY', 'BRIDGE_APP_ID', 'BRIDGE_PROFILE', 'XDG_CONFIG_HOME', 'BRIDGE_BASE_URL', 'BRIDGE_NO_BANNER']) {
    delete process.env[k];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-ws-apps-'));
  process.env.HOME = tmpHome;
  resetManagementClient();
  resetAppContext();
  setProfileOverride(null);

  routes = defaultRoutes();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
    const url = String(input);
    for (const r of routes) {
      const res = r(url, { method: 'GET', ...init });
      if (res) return res;
    }
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
  });

  appGet = jest.fn().mockResolvedValue({ id: 'whatever' });
  ManagementMock.mockReset();
  ManagementMock.mockImplementation(() => ({ app: { get: appGet } }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env = ORIGINAL_ENV;
});

type Run = { stdout: string; stderr: string; exitCode: number | undefined };

async function bridge(argv: string[], onStdout?: (all: string) => void): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    stdout += String(c);
    onStdout?.(stdout);
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
    stderr += String(c);
    return true;
  });
  const prev = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerGlobalOptions(program);
  registerCommands(program);
  try {
    await program.parseAsync(['node', 'bridge', ...argv]).catch(() => {
      if (!process.exitCode) process.exitCode = 1;
    });
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prev;
  return { stdout, stderr, exitCode };
}

/** The apiKey of the (last) management client a command built. */
const usedApiKey = () => ManagementMock.mock.calls.at(-1)?.[0]?.apiKey;
const tokenCalls = () =>
  fetchSpy.mock.calls.filter(([u]) => /\/workspace\/apps\/[^/]+\/token$/.test(String(u))).map(([u]) => String(u));
const stored = () => readCredentialsFile()!.credentials[HOME_ID];

// ---------------------------------------------------------------------------
// auth login — consent URL, stored scope, message, and the --app collision
// ---------------------------------------------------------------------------

describe('bridge auth login (TBP-769)', () => {
  async function login(argv: string[], appAccess: 'app' | 'workspace' | undefined) {
    process.env.BRIDGE_BASE_URL = BASE;
    process.env.BRIDGE_AUTH_BASE_URL = 'https://auth.example.com';
    routes = [
      (url) =>
        url === `${BASE}/v1/auth/cli/token`
          ? json({
              api_token: 'login-token',
              expires_at: '2099-01-01T00:00:00.000Z',
              app: { id: HOME_ID, name: 'Acme' },
              user: { id: 'u1', email: 'dev@acme.com' },
              ...(appAccess ? { app_access: appAccess } : {}),
            })
          : undefined,
    ];
    let authorize: URL | null = null;
    let driven = false;
    const result = await bridge(['auth', 'login', '--no-browser', ...argv], (out) => {
      const m = out.match(/https?:\/\/\S+\/cli\/authorize\?\S+/);
      if (!m || driven) return;
      driven = true;
      authorize = new URL(m[0]);
      const redirect = authorize.searchParams.get('redirect')!;
      const state = authorize.searchParams.get('state')!;
      setTimeout(() => {
        http.get(`${redirect}?code=C&state=${encodeURIComponent(state)}`, (res) => res.resume());
      }, 10);
    });
    return { ...result, authorize: authorize as URL | null };
  }

  it('asks for a workspace login by default and stores appAccess=workspace', async () => {
    const r = await login([], 'workspace');
    expect(r.exitCode).toBe(0);
    expect(r.authorize!.searchParams.get('app_access')).toBe('workspace');
    expect(stored().appAccess).toBe('workspace');
    expect(r.stdout).toContain('Logged in as dev@acme.com. Workspace: every app (home app: Acme)');
  }, 15_000);

  it('--single-app preselects app_access=app; the message names the one app', async () => {
    const r = await login(['--single-app'], 'app');
    expect(r.authorize!.searchParams.get('app_access')).toBe('app');
    expect(stored().appAccess).toBe('app');
    expect(r.stdout).toContain('Logged in as dev@acme.com. App: Acme.');
    expect(r.stdout).not.toContain('Workspace');
  }, 15_000);

  it('the user decides: a workspace request answered with app is stored as app', async () => {
    const r = await login([], 'app');
    expect(r.authorize!.searchParams.get('app_access')).toBe('workspace');
    expect(stored().appAccess).toBe('app');
  }, 15_000);

  it('`auth login --app X` still pins the home app on consent (global --app does not swallow it)', async () => {
    const r = await login(['--app', STAGE_ID], 'workspace');
    expect(r.exitCode).toBe(0);
    expect(r.authorize!.searchParams.get('app_id')).toBe(STAGE_ID);
    // No per-app token was fetched for a login.
    expect(tokenCalls()).toEqual([]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// app list / use / create
// ---------------------------------------------------------------------------

describe('bridge app list', () => {
  it('lists the apps with home and current marked, authenticating with the login token', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    const r = await bridge(['app', 'list']);
    expect(r.exitCode).toBeUndefined();
    const out = JSON.parse(r.stdout).data;
    expect(out.scope).toBe('workspace');
    expect(out.currentAppId).toBe(STAGE_ID);
    expect(out.apps.find((a: any) => a.home).id).toBe(HOME_ID);
    expect(out.apps.filter((a: any) => a.current).map((a: any) => a.id)).toEqual([STAGE_ID]);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers['x-api-key']).toBe('login-token');
  });

  it('current is the home app when nothing was chosen', async () => {
    writeCredentials(creds());
    const out = JSON.parse((await bridge(['app', 'list'])).stdout).data;
    expect(out.currentAppId).toBe(HOME_ID);
  });

  it('refuses BRIDGE_API_KEY with a clear message', async () => {
    process.env.BRIDGE_API_KEY = 'sk';
    const r = await bridge(['app', 'list']);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('bridge auth login');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('bridge app use', () => {
  it('by id: sets currentApp locally, no re-login, no token fetch', async () => {
    writeCredentials(creds());
    const r = await bridge(['app', 'use', STAGE_ID]);
    expect(r.exitCode).toBeUndefined();
    expect(stored().currentApp).toEqual({ id: STAGE_ID, name: 'Acme Stage' });
    expect(stored().apiKey).toBe('login-token');
    expect(tokenCalls()).toEqual([]);
    // No per-app token is ever written to disk.
    expect(fs.readFileSync(path.join(tmpHome, '.config/bridge/credentials.json'), 'utf8')).not.toContain('app-token-');
  });

  it('by name, case-insensitively', async () => {
    writeCredentials(creds());
    await bridge(['app', 'use', 'acme stage']);
    expect(stored().currentApp?.id).toBe(STAGE_ID);
  });

  it('the home app clears currentApp', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    await bridge(['app', 'use', 'Acme']);
    expect(stored().currentApp).toBeUndefined();
  });

  it('an ambiguous name is an error naming the ids, and changes nothing', async () => {
    writeCredentials(creds());
    const r = await bridge(['app', 'use', 'Twin']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stderr).error;
    expect(err.code).toBe('APP_AMBIGUOUS');
    expect(err.message).toContain(DUP1_ID);
    expect(err.message).toContain(DUP2_ID);
    expect(stored().currentApp).toBeUndefined();
  });

  it('an unknown app is an error listing the known ones', async () => {
    writeCredentials(creds());
    const r = await bridge(['app', 'use', 'Nope']);
    const err = JSON.parse(r.stderr).error;
    expect(r.exitCode).toBe(1);
    expect(err.code).toBe('APP_NOT_FOUND');
    expect(err.message).toContain('Acme Stage');
  });

  it('on a single-app login, explains how to get a workspace login', async () => {
    writeCredentials(creds({ appAccess: 'app' }));
    routes.unshift((url, init) =>
      url.endsWith('/v1/cli/workspace/apps') && init.method === 'GET'
        ? json({ scope: 'app', homeAppId: HOME_ID, apps: [{ id: HOME_ID, name: 'Acme', home: true }] })
        : undefined,
    );
    const r = await bridge(['app', 'use', STAGE_ID]);
    expect(r.exitCode).toBe(3);
    const err = JSON.parse(r.stderr).error;
    expect(err.message).toContain('covers only the app Acme');
    expect(err.hint).toMatch(/bridge auth login.*Every app/);
    expect(stored().currentApp).toBeUndefined();
  });
});

describe('bridge app create', () => {
  it('creates via the API and --use switches to it', async () => {
    writeCredentials(creds());
    routes.unshift((url, init) =>
      url === `${BASE}/v1/cli/workspace/apps` && init.method === 'POST'
        ? json({ app: { id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Acme Prod' } }, 201)
        : undefined,
    );
    const r = await bridge(['app', 'create', '--name', 'Acme Prod', '--callback-url', 'https://prod.acme.com/cb', '--use']);
    expect(r.exitCode).toBeUndefined();
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as any).body)).toEqual({ name: 'Acme Prod', callbackUrl: 'https://prod.acme.com/cb' });
    expect(JSON.parse(r.stdout).data).toEqual({ app: { id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Acme Prod' }, current: true });
    expect(stored().currentApp).toEqual({ id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Acme Prod' });
  });

  it('without --use leaves the current app alone', async () => {
    writeCredentials(creds());
    routes.unshift((url, init) =>
      url === `${BASE}/v1/cli/workspace/apps` && init.method === 'POST'
        ? json({ app: { id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Acme Prod' } }, 201)
        : undefined,
    );
    await bridge(['app', 'create', '--name', 'Acme Prod']);
    expect(stored().currentApp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Execution path: which token a management command acts with
// ---------------------------------------------------------------------------

describe('management commands on a workspace login', () => {
  it('home app (nothing chosen): access is re-checked via the token route, no Acting line', async () => {
    writeCredentials(creds());
    const r = await bridge(['app', 'get']);
    expect(tokenCalls()).toEqual([`${BASE}/v1/cli/workspace/apps/${HOME_ID}/token`]);
    expect(usedApiKey()).toBe('login-token');
    expect(r.stderr).not.toContain('Acting on app');
    expect(r.stderr).toContain(`bridge: Acme (${HOME_ID})`);
  });

  it('403 APP_NOT_IN_WORKSPACE for the home app stops the command with the fix', async () => {
    writeCredentials(creds());
    routes.unshift((url) =>
      url.endsWith(`/apps/${HOME_ID}/token`)
        ? json({ code: 'APP_NOT_IN_WORKSPACE', message: 'You no longer have access to this app.', fix: 'Ask a workspace admin to add you back, then run `bridge auth login`.' }, 403)
        : undefined,
    );
    const r = await bridge(['app', 'get']);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error).toMatchObject({
      code: 'APP_NOT_IN_WORKSPACE',
      message: 'You no longer have access to this app.',
      hint: 'Ask a workspace admin to add you back, then run `bridge auth login`.',
    });
    expect(appGet).not.toHaveBeenCalled();
  });

  it('currentApp: fetches that app token and says so on STDERR, stdout stays JSON', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    const r = await bridge(['app', 'get']);
    expect(tokenCalls()).toEqual([`${BASE}/v1/cli/workspace/apps/${STAGE_ID}/token`]);
    expect(usedApiKey()).toBe(`app-token-${STAGE_ID}`);
    expect(r.stderr).toContain(`Acting on app Acme Stage (${STAGE_ID})`);
    expect(r.stdout).not.toContain('Acting');
    expect(JSON.parse(r.stdout).success).toBe(true);
  });

  it('precedence: --app beats currentApp', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    await bridge(['--app', DUP1_ID, 'app', 'get']);
    expect(usedApiKey()).toBe(`app-token-${DUP1_ID}`);
  });

  it('--app after the subcommand works too, and by name', async () => {
    writeCredentials(creds());
    await bridge(['app', 'get', '--app', 'Acme Stage']);
    expect(usedApiKey()).toBe(`app-token-${STAGE_ID}`);
  });

  it('--app naming the home app uses the login token (beats currentApp)', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    await bridge(['--app', 'Acme', 'app', 'get']);
    expect(usedApiKey()).toBe('login-token');
    expect(tokenCalls()).toEqual([`${BASE}/v1/cli/workspace/apps/${HOME_ID}/token`]);
  });

  it('--app does not persist: the next command is back on currentApp/home', async () => {
    writeCredentials(creds());
    await bridge(['--app', STAGE_ID, 'app', 'get']);
    await bridge(['app', 'get']);
    expect(usedApiKey()).toBe('login-token');
    expect(stored().currentApp).toBeUndefined();
  });

  it('maps 403 APP_NOT_IN_CONNECTION to message + fix, non-zero exit, action not run', async () => {
    writeCredentials(creds());
    routes.unshift((url) =>
      /\/token$/.test(url)
        ? json({ code: 'APP_NOT_IN_CONNECTION', message: 'This login does not cover that app.', fix: 'Log in again and choose every app.' }, 403)
        : undefined,
    );
    const r = await bridge(['--app', STAGE_ID, 'app', 'get']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stderr).error;
    expect(err).toMatchObject({
      code: 'APP_NOT_IN_CONNECTION',
      message: 'This login does not cover that app.',
      hint: 'Log in again and choose every app.',
    });
    expect(appGet).not.toHaveBeenCalled();
  });

  it('maps a 400 INVALID_APP the same way', async () => {
    writeCredentials(creds());
    const r = await bridge(['--app', 'ffffffffffffffffffffffff', 'app', 'get']);
    expect(JSON.parse(r.stderr).error.code).toBe('INVALID_APP');
    expect(r.exitCode).toBe(1);
  });

  it('--profile picks the login, --app the app within it', async () => {
    writeCredentials(creds({ label: 'acme' }));
    writeCredentials(
      creds({ apiKey: 'other-login', app: { id: '111111111111111111111111', name: 'Other' }, label: 'other' }),
    ); // leaves "other" active
    await bridge(['--profile', 'acme', '--app', STAGE_ID, 'app', 'get']);
    expect(usedApiKey()).toBe(`app-token-${STAGE_ID}`);
    const [, init] = fetchSpy.mock.calls.find(([u]) => /\/token$/.test(String(u)))!;
    expect((init as any).headers['x-api-key']).toBe('login-token');
  });
});

describe('single-app login and BRIDGE_API_KEY behave as before', () => {
  it('single-app: login token, no token call (nor any workspace call)', async () => {
    writeCredentials(creds({ appAccess: 'app' }));
    await bridge(['app', 'get']);
    expect(usedApiKey()).toBe('login-token');
    expect(tokenCalls()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a credential stored before TBP-769 (no appAccess) is treated as single-app', async () => {
    const legacy = creds();
    delete legacy.appAccess;
    writeCredentials(legacy);
    await bridge(['app', 'get']);
    expect(usedApiKey()).toBe('login-token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('single-app + --app for another app: error with the fix, action not run', async () => {
    writeCredentials(creds({ appAccess: 'app' }));
    const r = await bridge(['--app', STAGE_ID, 'app', 'get']);
    expect(r.exitCode).toBe(3);
    const err = JSON.parse(r.stderr).error;
    expect(err.message).toContain('covers only the app Acme');
    expect(err.hint).toContain('bridge auth login');
    expect(appGet).not.toHaveBeenCalled();
  });

  it('BRIDGE_API_KEY: used as-is, no workspace calls', async () => {
    process.env.BRIDGE_API_KEY = 'sk-ci';
    await bridge(['app', 'get']);
    expect(usedApiKey()).toBe('sk-ci');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('BRIDGE_API_KEY + --app is an error, not a silent no-op', async () => {
    process.env.BRIDGE_API_KEY = 'sk-ci';
    const r = await bridge(['--app', STAGE_ID, 'app', 'get']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.message).toContain('BRIDGE_API_KEY is bound');
    expect(appGet).not.toHaveBeenCalled();
  });

  it('not logged in: the command reports it exactly as before', async () => {
    const r = await bridge(['app', 'get']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.message).toBe('Not logged in. Run `bridge auth login`.');
  });
});

describe('bridge auth status (TBP-769)', () => {
  it('shows scope, home app and current app', async () => {
    writeCredentials(creds({ currentApp: { id: STAGE_ID, name: 'Acme Stage' } }));
    const r = await bridge(['auth', 'status']);
    expect(r.stdout).toContain('scope=workspace (every app)');
    expect(r.stdout).toContain(`homeApp=Acme (${HOME_ID})`);
    expect(r.stdout).toContain(`currentApp=Acme Stage (${STAGE_ID})`);
  });

  it('single app', async () => {
    writeCredentials(creds({ appAccess: 'app' }));
    const r = await bridge(['auth', 'status']);
    expect(r.stdout).toContain('scope=single app');
  });
});
