/**
 * Opens an address in the default browser, with no shell anywhere.
 *
 * Each platform's opener gets the address as one argument of an argument
 * array, through `execFile`, which never starts a shell:
 *   - macOS:   `open <url>`
 *   - Windows: `rundll32 url.dll,FileProtocolHandler <url>`. Never `cmd /c start`:
 *     cmd cuts the address at `&` and runs what follows as commands.
 *   - Linux and the rest: `xdg-open <url>`
 *
 * Only addresses the CLI would call itself are opened: https, or http on
 * this machine. Anything else (`file:`, `javascript:`, a plain-http host) is
 * refused before any program runs.
 */
import { execFile } from 'node:child_process';
import { secureUrl } from '../core/urls.js';

export interface OpenBrowserResult {
  ok: boolean;
  /** Short reason the launch failed (only set when `ok === false`). */
  reason?: string;
}

/** The program and the argument array that open `url` on `platform`. Exposed for tests. */
export function browserCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean; shell: false },
  callback: (error: Error | null) => void,
) => { unref?: () => void; on?: (event: 'error', listener: (error: Error) => void) => unknown } | undefined;

export interface OpenBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: ExecFile;
}

/**
 * Attempts to open `url` in the person's default browser. Resolves to
 * `{ ok: true }` on success, `{ ok: false, reason }` on failure (the caller
 * then prints the address to open by hand).
 */
export async function openBrowser(url: string, deps: OpenBrowserDeps = {}): Promise<OpenBrowserResult> {
  const parsed = secureUrl(url);
  if (parsed === null) return { ok: false, reason: 'only https addresses (http on this machine) are opened' };
  const { command, args } = browserCommand(parsed.toString(), deps.platform ?? process.platform);
  const run = deps.execFile ?? (execFile as unknown as ExecFile);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: OpenBrowserResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = run(command, args, { windowsHide: true, shell: false }, (error) => {
        settle(error ? { ok: false, reason: error.message } : { ok: true });
      });
      child?.on?.('error', (error) => settle({ ok: false, reason: error.message }));
      // Don't keep the CLI alive for the opener.
      child?.unref?.();
    } catch (error) {
      settle({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Most openers return within a fraction of a second. If this one has not
    // answered in 2 s, assume the browser opened; the loopback's timeout
    // covers the case where no callback ever arrives.
    setTimeout(() => settle({ ok: true }), 2000).unref?.();
  });
}
