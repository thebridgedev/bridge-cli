import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.js';

/**
 * Files only their owner may read: the session and the settings.
 *
 * - The directory is made 0700, and an existing one must be a real
 *   directory (not a symlink) that this user owns; it is tightened to 0700.
 * - A file is written to a temporary file with a random name in the same
 *   directory, created with O_EXCL (which never follows a symlink) and mode
 *   0600, then renamed over the file.
 * - A file that is a symlink is refused, for reading and for writing.
 */
const POSIX = process.platform !== 'win32';

function refuse(message: string): CliError {
  return new CliError('misconfigured', message, { hint: 'Point BRIDGE_CONFIG_DIR at a directory only you can write to.' });
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw refuse(`${dir} is not a directory of its own (it is a symlink or a file).`);
  if (!POSIX) return;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw refuse(`${dir} belongs to another user.`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

async function notALink(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw refuse(`${path} is a symlink; the CLI does not follow it.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The file's text, or null when there is none. A file others could read is tightened to 0600 first. */
export async function readPrivateFile(dir: string, name: string): Promise<string | null> {
  const path = join(dir, name);
  if (!(await notALink(path))) return null;
  const flags = constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (POSIX && ((await handle.stat()).mode & 0o077) !== 0) await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(dir: string, name: string, content: string): Promise<void> {
  await ensurePrivateDir(dir);
  const path = join(dir, name);
  await notALink(path);
  const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    // The umask may have narrowed or widened the mode; it is 0600 whatever it is.
    if (POSIX) await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, path);
}

export async function removePrivateFile(dir: string, name: string): Promise<void> {
  await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
