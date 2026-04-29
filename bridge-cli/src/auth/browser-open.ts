/**
 * Cross-platform default-browser opener.
 *
 * Uses `child_process.spawn` to invoke the platform's "open this URL" command:
 *   - macOS:   `open <url>`
 *   - Windows: `cmd /c start "" <url>`   (the empty `""` is the window title;
 *              omitting it makes `start` interpret the URL as the title)
 *   - Linux:   `xdg-open <url>`          (most desktops; requires xdg-utils)
 *
 * Returns `false` if the spawn fails or the command exits non-zero, so callers
 * can fall back to printing the URL.
 *
 * Implemented directly on `child_process` to avoid a heavyweight dependency
 * for what is ~30 lines of platform detection.
 */
import { spawn } from 'node:child_process';

export interface OpenBrowserResult {
  ok: boolean;
  /** Short reason the launch failed (only set when `ok === false`). */
  reason?: string;
}

/**
 * Attempts to open `url` in the user's default browser. Resolves to
 * `{ ok: true }` on success, `{ ok: false, reason }` on failure (caller
 * should print the URL and ask the user to open it manually).
 */
export async function openBrowser(url: string): Promise<OpenBrowserResult> {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `cmd /c start "" <url>` — empty quoted string is the (ignored) window title.
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    // Treat anything else (linux, freebsd, etc.) as xdg-open.
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        // detached so the browser process lives independently of the CLI.
        // unref() so the CLI can exit without waiting for the browser to close.
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    let settled = false;
    const settle = (r: OpenBrowserResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    child.on('error', (err) => {
      settle({ ok: false, reason: err.message });
    });

    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        settle({ ok: true });
      } else {
        settle({ ok: false, reason: `${command} exited with code ${code}` });
      }
    });

    // Don't block CLI shutdown waiting on the browser process.
    child.unref?.();

    // Most platforms exit (or detach) within a fraction of a second. If we
    // don't hear back in 2s we optimistically declare success — at worst the
    // browser opened but the parent process hung. The user only sees a
    // problem if no callback ever arrives, and the loopback timeout handles
    // that case.
    setTimeout(() => settle({ ok: true }), 2000).unref?.();
  });
}
