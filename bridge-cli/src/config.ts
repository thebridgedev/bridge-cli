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
  /** The names of apps seen, by app id, so the line printed before each command can name the app it acts on. */
  appNames?: Record<string, string>;
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
 * Bridge's production server: where the CLI goes when nothing says otherwise, as 0.x did. Every command prints the
 * server it reaches (`bridge: <address> · server from …`), and a password is sent only to the issuer this server names on
 * its own address, so the default is never silent.
 */
export const DEFAULT_SERVER = 'https://api.thebridge.dev';

/**
 * Where the issuer comes from: `--issuer`, else `--server`, else `BRIDGE_ISSUER`, else `BRIDGE_SERVER`, else the one
 * saved at sign-in, else Bridge's production server. A server is Bridge's address (`https://api.example.com`); its issuer is read from it.
 */
export function issuerSource(
  flags: { issuer?: string; server?: string },
  env: NodeJS.ProcessEnv,
  settings: Settings,
): ({ issuer: string } | { server: string }) & { from: string } {
  const given = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';
  if (given(flags.issuer)) return { issuer: normalizeIssuer(flags.issuer), from: '--issuer' };
  if (given(flags.server)) return { server: flags.server.trim(), from: '--server' };
  if (given(env['BRIDGE_ISSUER'])) return { issuer: normalizeIssuer(env['BRIDGE_ISSUER']), from: 'BRIDGE_ISSUER' };
  if (given(env['BRIDGE_SERVER'])) return { server: env['BRIDGE_SERVER'].trim(), from: 'BRIDGE_SERVER' };
  if (given(settings.issuer)) return { issuer: normalizeIssuer(settings.issuer), from: 'the sign-in saved on this machine' };
  return { server: DEFAULT_SERVER, from: 'the default, Bridge\'s production server' };
}

/** The app commands act on: `--app`, else `BRIDGE_APP`, else the one chosen with `bridge app use`. */
export function resolveApp(flag: string | undefined, env: NodeJS.ProcessEnv, settings: Settings, issuer: string): string {
  return resolveAppWithSource(flag, env, settings, issuer).id;
}

/** The app commands act on, and what chose it: `--app`, `BRIDGE_APP` or `bridge app use`. */
export function resolveAppWithSource(flag: string | undefined, env: NodeJS.ProcessEnv, settings: Settings, issuer: string): { id: string; from: string } {
  const from = flag !== undefined ? '--app' : env['BRIDGE_APP'] !== undefined ? 'BRIDGE_APP' : 'the app chosen with `bridge app use`';
  const given = flag ?? env['BRIDGE_APP'] ?? settings.apps?.[issuer];
  if (given === undefined || given.trim() === '') {
    throw new CliError('misconfigured', 'No app is chosen.', {
      hint: 'Choose one with `bridge app use <id>`, pass `--app <id>`, or create one with `bridge app create --name <name>`.',
    });
  }
  return { id: given.trim(), from };
}
