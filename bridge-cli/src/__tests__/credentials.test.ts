/**
 * TBP-113 — credentials file management.
 *
 * Coverage:
 *  1. credentialsPath uses XDG_CONFIG_HOME when set; falls back to ~/.config/bridge.
 *  2. writeCredentials creates the parent dir + file with mode 0600.
 *  3. Round-trip read/write preserves all fields.
 *  4. deleteCredentials is idempotent (no throw on missing file).
 *  5. isExpired returns true for past timestamps and false for future ones.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  credentialsPath,
  deleteCredentials,
  isExpired,
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from '../credentials';

const ORIGINAL_ENV = process.env;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-creds-test-'));
}

function sampleCreds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    apiKey: 'fake-jwt-abc',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: 'app-1', name: 'Acme App' },
    user: { id: 'user-1', email: 'alice@acme.com' },
    baseUrl: 'https://api.thebridge.dev',
    ...overrides,
  };
}

describe('credentials', () => {
  let tmpHome: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.XDG_CONFIG_HOME;
    tmpHome = freshTmpHome();
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
  });

  describe('credentialsPath', () => {
    it('falls back to ~/.config/bridge/credentials.json when XDG_CONFIG_HOME is unset', () => {
      const expected = path.join(tmpHome, '.config', 'bridge', 'credentials.json');
      expect(credentialsPath()).toBe(expected);
    });

    it('uses $XDG_CONFIG_HOME/bridge/credentials.json when set', () => {
      const xdg = path.join(tmpHome, 'custom-xdg');
      process.env.XDG_CONFIG_HOME = xdg;
      expect(credentialsPath()).toBe(path.join(xdg, 'bridge', 'credentials.json'));
    });

    it('treats an empty XDG_CONFIG_HOME as unset', () => {
      process.env.XDG_CONFIG_HOME = '';
      const expected = path.join(tmpHome, '.config', 'bridge', 'credentials.json');
      expect(credentialsPath()).toBe(expected);
    });
  });

  describe('writeCredentials + readCredentials', () => {
    it('writes the file with mode 0600', () => {
      writeCredentials(sampleCreds());
      const stat = fs.statSync(credentialsPath());
      // On POSIX this is 0o600; on Windows the mode bits are different and
      // we don't enforce them. Skip the strict check on win32.
      if (process.platform !== 'win32') {
        // eslint-disable-next-line no-bitwise
        expect(stat.mode & 0o777).toBe(0o600);
      } else {
        expect(stat.isFile()).toBe(true);
      }
    });

    it('creates the parent directory if it does not exist', () => {
      const dir = path.dirname(credentialsPath());
      expect(fs.existsSync(dir)).toBe(false);
      writeCredentials(sampleCreds());
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('round-trips all fields, including optional label', () => {
      const original = sampleCreds({ label: 'work laptop' });
      writeCredentials(original);
      const back = readCredentials();
      expect(back).toEqual(original);
    });

    it('returns null when the file does not exist', () => {
      expect(readCredentials()).toBeNull();
    });

    it('throws a descriptive error when the file is malformed JSON', () => {
      const p = credentialsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{ not json');
      expect(() => readCredentials()).toThrow(/not valid JSON/);
    });

    it('throws when required fields are missing', () => {
      const p = credentialsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ apiKey: 'x' }));
      expect(() => readCredentials()).toThrow(/missing required fields/);
    });
  });

  describe('deleteCredentials', () => {
    it('removes the file', () => {
      writeCredentials(sampleCreds());
      expect(fs.existsSync(credentialsPath())).toBe(true);
      deleteCredentials();
      expect(fs.existsSync(credentialsPath())).toBe(false);
    });

    it('is a no-op when the file does not exist', () => {
      expect(() => deleteCredentials()).not.toThrow();
    });
  });

  describe('isExpired', () => {
    it('returns true for past expiresAt', () => {
      const c = sampleCreds({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(isExpired(c)).toBe(true);
    });

    it('returns false for future expiresAt', () => {
      const c = sampleCreds({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(isExpired(c)).toBe(false);
    });

    it('returns true for an unparseable expiresAt', () => {
      const c = sampleCreds({ expiresAt: 'not-a-date' });
      expect(isExpired(c)).toBe(true);
    });
  });
});
