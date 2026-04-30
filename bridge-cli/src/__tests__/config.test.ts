/**
 * TBP-106 / TBP-113 — verifies `getManagementClient()`'s resolution order.
 *
 * Resolution order (per TBP-107):
 *   1. `BRIDGE_API_KEY` env var (service-account / CI path).
 *   2. Credentials file at `~/.config/bridge/credentials.json` (or
 *      `$XDG_CONFIG_HOME/...`) written by `bridge auth login`.
 *   3. ConfigError("Not logged in. Run `bridge auth login`.").
 *
 * Coverage:
 *  1. (TBP-106) BRIDGE_BASE_URL unset + BRIDGE_API_KEY set → constructs with
 *     the default 'https://api.thebridge.dev'.
 *  2. (TBP-106) BRIDGE_BASE_URL=http://127.0.0.1:3200 → uses the env override.
 *  3. (TBP-106) BRIDGE_BASE_URL="" (empty string) → falls back to the default.
 *  4. (TBP-113) Env missing + valid creds file → uses the file's apiKey + baseUrl.
 *  5. (TBP-113) Env missing + expired creds file → ConfigError("Token expired").
 *  6. (TBP-113) Env missing + no creds file → ConfigError("Not logged in").
 *  7. (TBP-106) BRIDGE_DEBUG=true → emits a debug line on console.error.
 *
 * The module-level `_client` cache is reset between tests by re-importing the
 * module with `jest.isolateModules` so that each call to `getManagementClient`
 * runs the resolution logic fresh.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the auth-core package before any import resolves it. We capture the
// constructor calls so each test can introspect what was passed. The package
// may not be installed in node_modules during isolated test runs, so we mark
// the mock as `virtual` to bypass module resolution.
const ManagementMock = jest.fn();
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: ManagementMock,
  }),
  { virtual: true },
);

describe('getManagementClient (bridge-cli config)', () => {
  const ORIGINAL_ENV = process.env;
  let tmpHome: string;

  beforeEach(() => {
    jest.resetModules();
    ManagementMock.mockReset();
    // Build a fresh env each test so leftover values from other tests don't leak.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_BASE_URL;
    delete process.env.BRIDGE_DEBUG;
    delete process.env.XDG_CONFIG_HOME;
    // Each test gets a temp HOME so credentials-file lookups land somewhere
    // empty (and we own all writes there).
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-config-test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function writeCreds(overrides: Record<string, unknown> = {}): void {
    const dir = path.join(tmpHome, '.config', 'bridge');
    fs.mkdirSync(dir, { recursive: true });
    const creds = {
      apiKey: 'fake-jwt-from-file',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
      app: { id: 'a1', name: 'Acme' },
      user: { id: 'u1', email: 'alice@acme.com' },
      baseUrl: 'https://api.thebridge.dev',
      ...overrides,
    };
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(creds), { mode: 0o600 });
  }

  function loadConfig(): typeof import('../config') {
    let mod!: typeof import('../config');
    jest.isolateModules(() => {
      // Re-mock inside the isolated registry so the freshly-loaded config.ts
      // resolves to the same mock function we assert on.
      jest.doMock(
        '@nebulr-group/bridge-auth-core',
        () => ({
          __esModule: true,
          BridgeManagement: ManagementMock,
        }),
        { virtual: true },
      );
      mod = require('../config');
    });
    return mod;
  }

  it('uses the default base URL when BRIDGE_BASE_URL is unset', () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledTimes(1);
    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseUrl: 'https://api.thebridge.dev',
      }),
    );
  });

  it('uses the BRIDGE_BASE_URL env override when set', () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    process.env.BRIDGE_BASE_URL = 'http://127.0.0.1:3200';
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledTimes(1);
    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:3200',
      }),
    );
  });

  it('falls back to the default when BRIDGE_BASE_URL is an empty string', () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    process.env.BRIDGE_BASE_URL = '';
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledTimes(1);
    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseUrl: 'https://api.thebridge.dev',
      }),
    );
  });

  // TBP-113 — env missing, no credentials file → friendly "Not logged in" error.
  it('throws ConfigError("Not logged in") when env is missing and no credentials file exists', () => {
    const { getManagementClient, ConfigError } = loadConfig();

    expect(() => getManagementClient()).toThrow(ConfigError);
    expect(() => getManagementClient()).toThrow(/Not logged in/);
    expect(ManagementMock).not.toHaveBeenCalled();
  });

  // TBP-113 — env missing, valid credentials file → file's apiKey + baseUrl wins.
  it('uses the credentials file when BRIDGE_API_KEY is missing', () => {
    writeCreds({ apiKey: 'fake-jwt-from-file', baseUrl: 'https://api-from-file.example.com' });
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'fake-jwt-from-file',
        baseUrl: 'https://api-from-file.example.com',
      }),
    );
  });

  // TBP-113 — credentials file (from `bridge auth login`) wins over BRIDGE_API_KEY.
  // Rationale: login is the interactive primary path, so a fresh login takes
  // effect immediately even when an old env var is still exported.
  it('prefers the credentials file over BRIDGE_API_KEY when both are present', () => {
    writeCreds({ apiKey: 'fake-jwt-from-file' });
    process.env.BRIDGE_API_KEY = 'env-key';
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'fake-jwt-from-file' }),
    );
  });

  // TBP-113 — env missing, file present but expired → friendly re-login error.
  it('throws ConfigError("Token expired") when the credentials file is expired', () => {
    writeCreds({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const { getManagementClient, ConfigError } = loadConfig();

    expect(() => getManagementClient()).toThrow(ConfigError);
    expect(() => getManagementClient()).toThrow(/Token expired/);
    expect(ManagementMock).not.toHaveBeenCalled();
  });

  // TBP-113 — BRIDGE_BASE_URL env override applies even when the apiKey came
  // from the file (useful for hitting a local bridge-api with prod credentials).
  it('lets BRIDGE_BASE_URL override the credentials file baseUrl', () => {
    writeCreds({ baseUrl: 'https://api.thebridge.dev' });
    process.env.BRIDGE_BASE_URL = 'http://127.0.0.1:3200';
    const { getManagementClient } = loadConfig();

    getManagementClient();

    expect(ManagementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'fake-jwt-from-file',
        baseUrl: 'http://127.0.0.1:3200',
      }),
    );
  });

  describe('BRIDGE_DEBUG=true logging', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('logs "(default)" when BRIDGE_BASE_URL is unset', () => {
      process.env.BRIDGE_API_KEY = 'test-key';
      process.env.BRIDGE_DEBUG = 'true';
      const { getManagementClient } = loadConfig();

      getManagementClient();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0][0]);
      expect(logged).toContain('(default)');
      expect(logged).toContain('https://api.thebridge.dev');
    });

    it('logs "(env)" when BRIDGE_BASE_URL is provided', () => {
      process.env.BRIDGE_API_KEY = 'test-key';
      process.env.BRIDGE_BASE_URL = 'http://127.0.0.1:3200';
      process.env.BRIDGE_DEBUG = 'true';
      const { getManagementClient } = loadConfig();

      getManagementClient();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0][0]);
      expect(logged).toContain('(env)');
      expect(logged).toContain('http://127.0.0.1:3200');
    });
  });
});
