import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../../auth/store';
import type { Deps } from '../../commands/context';
import type { Fetch } from '../../core/http';
import { exitCodeOf } from '../../core/errors';
import { errorBody, type Io } from '../../io';
import { buildProgram } from '../../program';
import { ISSUER, type FakeBridge } from './fake-bridge';

export interface Run {
  results: unknown[];
  errors: Record<string, unknown>[];
  infos: string[];
  texts: string[];
  exitCode: number;
  /** The one result, for commands that give one. */
  readonly data: any;
  readonly error: Record<string, unknown> | undefined;
}

export interface RunOptions {
  stdin?: string;
  interactive?: boolean;
  answers?: string[];
  env?: Record<string, string>;
  openBrowser?: Deps['openBrowser'];
  fetch?: Fetch;
}

/** A CLI with its own config dir, a file token store and the fake Bridge. */
export function createCli(fake: FakeBridge, base: { env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cli-test-'));
  const env: Record<string, string> = { BRIDGE_CONFIG_DIR: dir, BRIDGE_TOKEN_STORE: 'file', BRIDGE_ISSUER: ISSUER, ...base.env };

  async function run(args: string[], options: RunOptions = {}): Promise<Run> {
    const results: unknown[] = [];
    const errors: Record<string, unknown>[] = [];
    const infos: string[] = [];
    const texts: string[] = [];
    let exitCode = 0;
    const answers = [...(options.answers ?? [])];
    const io: Io = {
      result: (data) => results.push(JSON.parse(JSON.stringify(data ?? null))),
      text: (content) => texts.push(content),
      info: (message) => infos.push(message),
      error: (error) => {
        errors.push(errorBody(error));
        exitCode = exitCodeOf(error);
      },
      interactive: options.interactive ?? false,
      ask: async () => answers.shift() ?? '',
      askHidden: async () => answers.shift() ?? '',
      readStdin: async () => options.stdin ?? '',
      setExitCode: (code) => {
        exitCode = code;
      },
    };
    const program = buildProgram({
      fetch: options.fetch ?? fake.fetch,
      env: { ...env, ...options.env },
      io,
      openBrowser: options.openBrowser ?? (async () => ({ ok: false })),
      store: (configDir) => new FileStore(configDir),
      now: fake.now,
      signInTimeoutMs: 5_000,
    });
    // commander's own refusals (a missing option, an unknown command) throw instead of exiting, on every command.
    const quiet = (command: typeof program) => {
      command.exitOverride();
      command.configureOutput({ writeOut: (s) => texts.push(s), writeErr: (s) => infos.push(s) });
      command.commands.forEach(quiet);
    };
    quiet(program);
    try {
      await program.parseAsync(['node', 'bridge', ...args]);
    } catch (error) {
      // commander's own refusals (a missing option, an unknown command).
      errors.push({ code: 'usage', message: error instanceof Error ? error.message : String(error) });
      exitCode = exitCode || 1;
    }
    return {
      results,
      errors,
      infos,
      texts,
      exitCode,
      get data() {
        return results[results.length - 1] as any;
      },
      get error() {
        return errors[errors.length - 1];
      },
    };
  }

  return {
    dir,
    env,
    run,
    /** Signs in with the password, in the person's only workspace, and checks it worked. */
    async signIn(email = 'dev@example.com', password = 'correct horse') {
      const done = await run(['auth', 'login', '--password', '--email', email, '--password-stdin'], { stdin: `${password}\n` });
      if (done.exitCode !== 0) throw new Error(`sign-in failed: ${JSON.stringify(done.errors)}`);
      return done;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
