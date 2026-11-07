import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir } from '../core/private-files.js';

const STALE_MS = 30_000;
const WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding a lock file, so two commands running at once never
 * renew with the same refresh token. Bridge rotates refresh tokens and ends
 * the session when one is used twice; this keeps that from happening by
 * accident. A lock left by a command that crashed is taken over after 30 s.
 */
export async function withLock<T>(dir: string, name: string, fn: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(dir);
  const path = join(dir, `${name}.lock`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await lstat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > STALE_MS) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Another bridge command holds ${path}. If none is running, delete that file.`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
