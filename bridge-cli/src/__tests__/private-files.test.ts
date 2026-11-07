/**
 * The session and settings files: written to a new 0600 file in a 0700
 * directory this user owns, then renamed into place, with no symlink
 * followed for reading or writing.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, type StoredSession } from '../auth/store';
import { Config } from '../config';
import { ensurePrivateDir, readPrivateFile, writePrivateFile } from '../core/private-files';

const session: StoredSession = { issuer: 'https://bridge.test/identity-access/apps/a', appId: 'a', accessToken: 'at-1', accessTokenExpiresAt: 1, refreshToken: 'rt-1', workspace: null, signedInAt: 1 };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-private-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('private files', () => {
  it('writes 0600 whatever the umask, in a 0700 directory, and leaves no temporary file', async () => {
    const dir = join(root, 'cfg');
    const old = process.umask(0o000);
    try {
      await writePrivateFile(dir, 'sessions.json', '{}');
    } finally {
      process.umask(old);
    }
    expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });

  it('tightens a directory others can read or write to 0700', async () => {
    const dir = join(root, 'open');
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    await ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a config directory that is a symlink', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    await expect(writePrivateFile(join(root, 'link'), 'config.json', '{}')).rejects.toThrow(/symlink/);
    await expect(new FileStore(join(root, 'link')).write(session)).rejects.toThrow(/symlink/);
  });

  it('refuses a sessions.json that is a symlink, and writes nothing through it', async () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const elsewhere = join(root, 'someone-elses-file');
    writeFileSync(elsewhere, 'untouched');
    symlinkSync(elsewhere, join(dir, 'sessions.json'));
    const store = new FileStore(dir);
    await expect(store.write(session)).rejects.toThrow(/symlink/);
    await expect(store.read(session.issuer)).rejects.toThrow(/symlink/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(lstatSync(join(dir, 'sessions.json')).isSymbolicLink()).toBe(true);
  });

  it('refuses a config.json that is a symlink', async () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(root, 'target'), '{"issuer":"https://evil.test/identity-access/apps/x"}');
    symlinkSync(join(root, 'target'), join(dir, 'config.json'));
    await expect(new Config(dir).update(() => undefined)).rejects.toThrow(/symlink/);
    await expect(readPrivateFile(dir, 'config.json')).rejects.toThrow(/symlink/);
  });

  it('tightens a file others could read before reading it', async () => {
    const dir = join(root, 'cfg');
    await writePrivateFile(dir, 'config.json', '{"issuer":"https://bridge.test"}');
    chmodSync(join(dir, 'config.json'), 0o644);
    expect(await readPrivateFile(dir, 'config.json')).toBe('{"issuer":"https://bridge.test"}');
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  });
});
