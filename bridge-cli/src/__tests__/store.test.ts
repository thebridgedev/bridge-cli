/**
 * Where the session is kept: the OS keychain when there is one (secrets on
 * stdin, never in arguments), else a file only its owner can read.
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseStore, FileStore, KeychainWithFileStore, MacKeychainStore, SecretToolStore, type Runner, type StoredSession } from '../auth/store';

const session: StoredSession = {
  issuer: 'https://bridge.test/identity-access/apps/bridge-app',
  appId: 'bridge-app',
  accessToken: 'at-secret',
  accessTokenExpiresAt: 1,
  refreshToken: 'rt-secret',
  workspace: 'ws-1',
  signedInAt: 1,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A keychain tool that keeps entries in memory and records every call. */
function fakeKeychain(options: { refuseWrites?: boolean } = {}) {
  const entries = new Map<string, string>();
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const run: Runner = async (command, args, input) => {
    calls.push({ command, args, input });
    if (command === 'security' && args[0] === '-i') {
      if (options.refuseWrites) return { code: 0, stdout: '', stderr: 'security: SecKeychainItemCreateFromContent: User interaction is not allowed. error' };
      const account = /-a "([^"]+)"/.exec(input ?? '')?.[1] as string;
      entries.set(account, /-w "([^"]+)"/.exec(input ?? '')?.[1] as string);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'security' && args[0] === 'find-generic-password') {
      const value = entries.get(args[args.indexOf('-a') + 1] as string);
      return value === undefined ? { code: 44, stdout: '', stderr: 'not found' } : { code: 0, stdout: `${value}\n`, stderr: '' };
    }
    if (command === 'security' && args[0] === 'delete-generic-password') {
      entries.delete(args[args.indexOf('-a') + 1] as string);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'secret-tool' && args[0] === 'store') {
      entries.set(args[args.length - 1] as string, input ?? '');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'secret-tool' && args[0] === 'lookup') {
      const value = entries.get(args[args.length - 1] as string);
      return value === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: value, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return { run, calls, entries };
}

describe('FileStore', () => {
  it('writes the session readable only by its owner, and removes the file with the last session', async () => {
    const store = new FileStore(join(dir, 'cfg'));
    await store.write(session);
    expect(statSync(join(dir, 'cfg', 'sessions.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cfg')).mode & 0o077).toBe(0);
    expect(await store.read(session.issuer)).toEqual(session);
    await store.remove(session.issuer);
    expect(() => statSync(join(dir, 'cfg', 'sessions.json'))).toThrow();
  });

  it('takes away read access others were given before reading', async () => {
    const file = join(dir, 'sessions.json');
    writeFileSync(file, JSON.stringify({ [session.issuer]: session }));
    chmodSync(file, 0o644);
    expect(await new FileStore(dir).read(session.issuer)).toEqual(session);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('the keychain', () => {
  it('macOS: the session goes in on stdin, never in the arguments', async () => {
    const keychain = fakeKeychain();
    const store = new MacKeychainStore(keychain.run);
    await store.write(session);
    const write = keychain.calls[0];
    expect(write?.args).toEqual(['-i']);
    expect(write?.args.join(' ')).not.toContain('rt-secret');
    expect(write?.input).toContain('-s bridge-cli');
    expect(write?.input).not.toContain('rt-secret');
    expect(await store.read(session.issuer)).toEqual(session);
    expect(keychain.calls.every((call) => !call.args.join(' ').includes(Buffer.from(JSON.stringify(session)).toString('base64')))).toBe(true);
    await store.remove(session.issuer);
    expect(await store.read(session.issuer)).toBeNull();
  });

  it('Linux: secret-tool reads the session from stdin', async () => {
    const keychain = fakeKeychain();
    const store = new SecretToolStore(keychain.run);
    await store.write(session);
    expect(keychain.calls[0]?.args).toEqual(['store', '--label=Bridge CLI session', 'service', 'bridge-cli', 'account', session.issuer]);
    expect(await store.read(session.issuer)).toEqual(session);
  });

  it('falls back to the 0600 file when the keychain refuses, and says so', async () => {
    const keychain = fakeKeychain({ refuseWrites: true });
    const warnings: string[] = [];
    const store = new KeychainWithFileStore(new MacKeychainStore(keychain.run), new FileStore(dir), (m) => warnings.push(m));
    await store.write(session);
    expect(warnings[0]).toContain('Keeping it in file');
    expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600);
    expect(await store.read(session.issuer)).toEqual(session);
  });

  it('keeps the session in the keychain only, once the keychain takes it', async () => {
    const keychain = fakeKeychain();
    const file = new FileStore(dir);
    await file.write(session);
    const store = new KeychainWithFileStore(new MacKeychainStore(keychain.run), file, () => undefined);
    await store.write({ ...session, refreshToken: 'rt-newer' });
    expect(await file.read(session.issuer)).toBeNull();
    expect((await store.read(session.issuer))?.refreshToken).toBe('rt-newer');
  });

  it('chooses: BRIDGE_TOKEN_STORE=file forces the file; the keychain where the machine has one', () => {
    expect(chooseStore({ dir, env: { BRIDGE_TOKEN_STORE: 'file' }, platform: 'darwin' }).describe()).toMatch(/^file /);
    expect(chooseStore({ dir, env: { BRIDGE_TOKEN_STORE: 'keychain' }, platform: 'darwin' }).describe()).toBe('macOS keychain');
    expect(chooseStore({ dir, env: { PATH: '' }, platform: 'linux' }).describe()).toMatch(/^file /);
    expect(chooseStore({ dir, env: {}, platform: 'win32' }).describe()).toMatch(/^file /);
    expect(() => chooseStore({ dir, env: { BRIDGE_TOKEN_STORE: 'keychain' }, platform: 'win32' })).toThrow(/no keychain/);
  });
});
