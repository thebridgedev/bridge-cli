import type { Command } from 'commander';
import { Sessions } from '../auth/session.js';
import { chooseStore, type SessionStore } from '../auth/store.js';
import { BridgeClient } from '../client.js';
import { Config, configDir, issuerSource, resolveApp, type Settings } from '../config.js';
import { discover, issuerAtServer, type Discovery } from '../core/discovery.js';
import type { Fetch } from '../core/http.js';
import type { Io } from '../io.js';

/** What the commands run with. Real ones in `cli.ts`; tests pass fakes. */
export interface Deps {
  readonly fetch: Fetch;
  readonly env: NodeJS.ProcessEnv;
  readonly io: Io;
  readonly openBrowser: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** The session store for a config dir; by default the keychain, else a 0600 file. */
  readonly store?: (dir: string) => SessionStore;
  readonly now?: () => number;
  /** How long browser sign-in waits for the page, in ms. */
  readonly signInTimeoutMs?: number;
}

export interface GlobalOptions {
  readonly issuer?: string;
  readonly server?: string;
  readonly app?: string;
}

/** One command's view of the CLI: settings, the issuer, the session, the client. Each is worked out once. */
export class Context {
  readonly config: Config;
  private settingsRead?: Settings;
  private discovered?: Promise<Discovery>;
  private issuerFound?: Promise<string>;
  private sessionsMade?: Sessions;

  constructor(
    readonly deps: Deps,
    readonly options: GlobalOptions,
  ) {
    this.config = new Config(configDir(deps.env));
  }

  get io(): Io {
    return this.deps.io;
  }

  get env(): NodeJS.ProcessEnv {
    return this.deps.env;
  }

  async settings(): Promise<Settings> {
    this.settingsRead ??= await this.config.read();
    return this.settingsRead;
  }

  /** The Bridge App's issuer: given, saved, or read from the server given with `--server` / `BRIDGE_SERVER`. */
  issuer(): Promise<string> {
    this.issuerFound ??= this.settings().then((settings) => {
      const source = issuerSource(this.options, this.env, settings);
      return 'issuer' in source ? source.issuer : issuerAtServer(this.deps.fetch, source.server);
    });
    return this.issuerFound;
  }

  discovery(): Promise<Discovery> {
    this.discovered ??= this.issuer().then((issuer) => discover(this.deps.fetch, issuer));
    return this.discovered;
  }

  sessions(): Sessions {
    this.sessionsMade ??= new Sessions({
      fetch: this.deps.fetch,
      store: (this.deps.store ?? ((dir) => chooseStore({ dir, env: this.env, warn: (m) => this.io.info(m) })))(this.config.dir),
      lockDir: this.config.dir,
      now: this.deps.now,
    });
    return this.sessionsMade;
  }

  async client(): Promise<BridgeClient> {
    return new BridgeClient(await this.discovery(), this.deps.fetch, this.sessions());
  }

  /** The app commands act on. */
  async appId(): Promise<string> {
    return resolveApp(this.options.app, this.env, await this.settings(), await this.issuer());
  }

  /** The app and a client, for the commands that act on one app. */
  async forApp(): Promise<{ c: BridgeClient; appId: string }> {
    const [c, appId] = await Promise.all([this.client(), this.appId()]);
    return { c, appId };
  }
}

/**
 * The action wrapper every command uses: builds the context from the global
 * options, runs the command, and reports any error the one way.
 */
export function action<A extends unknown[]>(deps: Deps, fn: (ctx: Context, ...args: A) => Promise<void>) {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const ctx = new Context(deps, command.optsWithGlobals() as GlobalOptions);
    try {
      await fn(ctx, ...(args.slice(0, -1) as A));
    } catch (error) {
      deps.io.error(error);
    }
  };
}

/** Repeated options (`--use a --use b`). */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
