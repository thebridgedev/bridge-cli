/**
 * TBP-541 — `getManagementHttp()` must authenticate exactly as
 * `getManagementClient()` does: same key, same base URL, same precedence. A
 * raw client resolved any other way could call the integration routes as a
 * different app from the one the banner names.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ManagementMock = jest.fn();
const HttpMock = jest.fn();

describe('getManagementHttp (TBP-541)', () => {
  const ORIGINAL_ENV = process.env;
  let tmpHome: string;

  beforeEach(() => {
    jest.resetModules();
    ManagementMock.mockReset();
    HttpMock.mockReset();
    process.env = { ...ORIGINAL_ENV, BRIDGE_NO_BANNER: 'true' };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_BASE_URL;
    delete process.env.BRIDGE_PROFILE;
    delete process.env.XDG_CONFIG_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-http-test-'));
    process.env.HOME = tmpHome;
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
  afterAll(() => { process.env = ORIGINAL_ENV; });

  function loadConfig(): typeof import('../config') {
    let mod!: typeof import('../config');
    jest.isolateModules(() => {
      jest.doMock('@nebulr-group/bridge-auth-core', () => ({
        __esModule: true, BridgeManagement: ManagementMock, ManagementHttpClient: HttpMock,
      }));
      mod = require('../config');
    });
    return mod;
  }

  it('uses the key and base URL the management client resolved', () => {
    process.env.BRIDGE_API_KEY = 'env-key';
    process.env.BRIDGE_BASE_URL = 'http://127.0.0.1:3200';
    const { getManagementHttp, getManagementClient } = loadConfig();
    getManagementHttp();
    expect(HttpMock).toHaveBeenCalledWith('http://127.0.0.1:3200', 'env-key', expect.any(Object));
    expect(ManagementMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-key', baseUrl: 'http://127.0.0.1:3200' }));
    getManagementClient();
    expect(ManagementMock).toHaveBeenCalledTimes(1);
  });

  it('the credentials file beats BRIDGE_API_KEY for both clients', () => {
    const dir = path.join(tmpHome, '.config', 'bridge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
      apiKey: 'file-key', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), issuedAt: new Date().toISOString(),
      app: { id: 'a1', name: 'Acme' }, user: { id: 'u1', email: 'a@acme.com' }, baseUrl: 'https://api.stage.example',
    }), { mode: 0o600 });
    process.env.BRIDGE_API_KEY = 'env-key';
    const { getManagementHttp } = loadConfig();
    getManagementHttp();
    expect(HttpMock).toHaveBeenCalledWith('https://api.stage.example', 'file-key', expect.any(Object));
  });

  it('refuses when not logged in, like every other command', () => {
    const { getManagementHttp } = loadConfig();
    expect(() => getManagementHttp()).toThrow(/Not logged in/);
    expect(HttpMock).not.toHaveBeenCalled();
  });
});
