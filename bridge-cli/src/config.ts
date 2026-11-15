import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './core/errors.js';
import { readPrivateFile, writePrivateFile } from './core/private-files.js';
import { normalizeIssuer } from './core/urls.js';

/**
 * The CLI's settings, in `<config dir>/config.json`, readable only by its owner:
 *   - `issuer`: the Bridge App's issuer, the one address the CLI needs;
 *   - `apps`: the app chosen with `bridge app use`, per issuer.
 *
 * The config dir is `$BRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/bridge/v1`,
 * else `~/.config/bridge/v1` (`%APPDATA%\bridge\v1` on Windows). It is kept
 * apart from the files of 0.x versions of this CLI.
 */
export interface Settings {
  issuer?: string;
  apps?: Record<string, string>;
}

export function configDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const given = env['BRIDGE_CONFIG_DIR']?.trim();
  if (given) return given;
  if (platform === 'win32' && env['APPDATA']) return join(env['APPDATA'], 'bridge', 'v1');
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  if (xdg) return join(xdg, 'bridge', 'v1');
  const home = env['HOME']?.trim() || homedir();
  return join(home, '.config', 'bridge', 'v1');
}

export class Config {
  constructor(readonly dir: string) {}

  async read(): Promise<Settings> {
    const raw = await readPrivateFile(this.dir, FILE);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : {};
    } catch {
      return {};
    }
  }

  async update(change: (settings: Settings) => void): Promise<Settings> {
    const settings = await this.read();
    change(settings);
    await writePrivateFile(this.dir, FILE, JSON.stringify(settings, null, 2) + '\n');
    return settings;
  }
}

const FILE = 'config.json';

/**
 * Where the issuer comes from: `--issuer`, else `--server`, else `BRIDGE_ISSUER`, else `BRIDGE_SERVER`, else the one
 * saved at sign-in. A server is Bridge's address (`https://api.example.com`); its issuer is read from it.
 */
export function issuerSource(flags: { issuer?: string; server?: string }, env: NodeJS.ProcessEnv, settings: Settings): { issuer: string } | { server: string } {
  const given = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';
  if (given(flags.issuer)) return { issuer: normalizeIssuer(flags.issuer) };
  if (given(flags.server)) return { server: flags.server.trim() };
  if (given(env['BRIDGE_ISSUER'])) return { issuer: normalizeIssuer(env['BRIDGE_ISSUER']) };
  if (given(env['BRIDGE_SERVER'])) return { server: env['BRIDGE_SERVER'].trim() };
  if (given(settings.issuer)) return { issuer: normalizeIssuer(settings.issuer) };
  throw new CliError('misconfigured', 'No Bridge server is set.', {
    hint: 'Sign in with `bridge auth login --server <Bridge\'s address>`, or set BRIDGE_SERVER.',
  });
}

/** The app commands act on: `--app`, else `BRIDGE_APP`, else the one chosen with `bridge app use`. */
export function resolveApp(flag: string | undefined, env: NodeJS.ProcessEnv, settings: Settings, issuer: string): string {
  const given = flag ?? env['BRIDGE_APP'] ?? settings.apps?.[issuer];
  if (given === undefined || given.trim() === '') {
    throw new CliError('misconfigured', 'No app is chosen.', {
      hint: 'Choose one with `bridge app use <id>`, pass `--app <id>`, or create one with `bridge app create --name <name>`.',
    });
  }
  return given.trim();
}
