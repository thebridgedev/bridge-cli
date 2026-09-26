import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { getManagementHttp } from '../config.js';
import { outputError, outputSuccess } from '../output.js';
import { detectFramework } from './flag-init.command.js';

/*
 * TBP-541 — "prove login works, and say why it failed", from a shell.
 *
 *   bridge diagnose              compare the project's .env files with the app
 *   bridge setup status          readiness checklist, with next steps
 *   bridge test-user create      a marked test user with a generated password
 *   bridge test-user verify      a real sign-in, verified against the JWKS
 *   bridge event auth-attempts   a user's recent attempts and why each failed
 *
 * Thin callers of bridge-api `/v1/account/integration/*` — the same routes the
 * MCP tools (diagnose_integration, get_setup_status, create_test_user,
 * verify_login, debug_auth_issue) call, so the two answer identically. The
 * server writes each remediation as `fix`; the CLI's contract calls it `hint`
 * (see output.ts), so results are renamed on the way out.
 */

const BASE = '/v1/account/integration';

/** The .env files read by default, lowest precedence first (later files win). */
export const DEFAULT_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

const FRAMEWORKS = ['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express'];

/** A variable whose value is a secret: only its presence is ever sent. */
export function isSecretName(name: string): boolean {
  return /API_KEY|SECRET|TOKEN|PASSWORD/i.test(name);
}

/** The placeholder sent instead of a secret's value. */
export const SECRET_PLACEHOLDER = '<set>';

/** Parse dotenv text: KEY=VALUE lines, optional `export`, quotes, comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

/**
 * What `bridge diagnose` sends: Bridge-related variables only, and for a
 * secret nothing but the fact that it is set. The value of BRIDGE_API_KEY
 * (or any *_KEY / *_SECRET) never leaves the machine.
 */
export function bridgeEnvToSend(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/BRIDGE/i.test(name)) continue;
    if (isSecretName(name)) {
      if (value.trim() !== '') out[name] = SECRET_PLACEHOLDER;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Rename every `fix` key to `hint`, the CLI's word for it. */
export function fixToHint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixToHint);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k === 'fix' ? 'hint' : k, fixToHint(v)]),
    );
  }
  return value;
}

async function readEnvFiles(cwd: string, files: string[] | undefined): Promise<{ env: Record<string, string>; read: string[] }> {
  const explicit = !!files && files.length > 0;
  const candidates = explicit ? files! : DEFAULT_ENV_FILES;
  const env: Record<string, string> = {};
  const read: string[] = [];
  for (const file of candidates) {
    const path = resolve(cwd, file);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      if (explicit) {
        throw Object.assign(new Error(`Cannot read env file ${file}.`), { code: 'ENV_FILE_NOT_FOUND' });
      }
      continue;
    }
    Object.assign(env, parseDotenv(text));
    read.push(explicit ? file : basename(path));
  }
  return { env, read };
}

export interface DiagnoseOptions {
  envFile?: string[];
  framework?: string;
  dir?: string;
}

export async function diagnose(opts: DiagnoseOptions): Promise<Record<string, unknown> & { ok?: boolean }> {
  const cwd = opts.dir ? resolve(opts.dir) : process.cwd();
  if (opts.framework && !FRAMEWORKS.includes(opts.framework)) {
    throw Object.assign(new Error(`Unknown framework "${opts.framework}". Use one of: ${FRAMEWORKS.join(', ')}.`), {
      code: 'INVALID_ARGUMENT',
    });
  }
  const { env, read } = await readEnvFiles(cwd, opts.envFile);
  const detected = opts.framework ?? (await detectFramework(cwd));
  const framework = detected && detected !== 'unknown' ? detected : undefined;
  const sent = bridgeEnvToSend(env);

  const result = await getManagementHttp().post<Record<string, unknown>>(`${BASE}/diagnose`, {
    env: sent,
    ...(framework ? { framework } : {}),
  });
  return {
    ...(fixToHint(result) as Record<string, unknown>),
    envFilesRead: read,
    // Names only: what was compared, never the values of secrets.
    secretsSentAsPresenceOnly: Object.keys(sent).filter(isSecretName),
  };
}

export function registerIntegrationCommands(program: Command): void {
  program.command('diagnose')
    .description("Check this project's Bridge env vars against the app and list every difference with a fix")
    .option('--env-file <path...>', `Env file(s) to read, later ones winning (default: ${DEFAULT_ENV_FILES.join(', ')} if present)`)
    .option('--framework <name>', `Framework: ${FRAMEWORKS.join(', ')} (default: detected from package.json)`)
    .option('--dir <path>', 'Project directory (default: current directory)')
    .action(async (opts: DiagnoseOptions) => {
      try {
        const result = await diagnose(opts);
        outputSuccess(result);
        if (result.ok === false) process.exitCode = 1;
      } catch (err) { outputError(err); }
    });

  const setup = program.commands.find((c) => c.name() === 'setup') ?? program.command('setup');
  setup.command('status')
    .description('Readiness checklist: what is configured, what is missing, the next step for each, and what production needs')
    .action(async () => {
      try {
        outputSuccess(fixToHint(await getManagementHttp().get(`${BASE}/status`)));
      } catch (err) { outputError(err); }
    });

  const testUser = program.command('test-user').description('Create a test user and prove sign-in works');

  testUser.command('create')
    .description('Create a marked test user ("[test] …" workspace, no plan, no emails) with a generated password')
    .option('--confirm <app name>', "Required on production or with live Stripe keys: the app's exact name")
    .action(async (opts: { confirm?: string }) => {
      try {
        const body = opts.confirm !== undefined ? { confirm: opts.confirm } : {};
        outputSuccess(fixToHint(await getManagementHttp().post(`${BASE}/test-user`, body)));
      } catch (err) { outputError(err); }
    });

  testUser.command('verify')
    .description('Sign in for real and verify the token against the JWKS; prints evidence, never tokens')
    .requiredOption('--email <email>', 'Email of the user to sign in as')
    .requiredOption('--password <password>', 'Their password (used once, never stored or printed)')
    .option('--origin <origin>', "Origin to sign in from; must be one of the app's allowed origins")
    .action(async (opts: { email: string; password: string; origin?: string }) => {
      try {
        const body = { email: opts.email, password: opts.password, ...(opts.origin ? { origin: opts.origin } : {}) };
        const result = await getManagementHttp().post<{ verified?: boolean }>(`${BASE}/verify-login`, body);
        outputSuccess(fixToHint(result));
        if (result?.verified === false) process.exitCode = 1;
      } catch (err) { outputError(err); }
    });

  const event = program.commands.find((c) => c.name() === 'event') ?? program.command('event');
  event.command('auth-attempts')
    .description("A user's recent sign-in attempts, each failure with its reason and a hint")
    .requiredOption('--user <email|id>', "The user's email address (or user id)")
    .option('--since <duration>', 'How far back: 24h, 7d, 2w or an ISO date')
    .option('--limit <n>', 'Most attempts to return (default 20, max 100)', (v) => parseInt(v, 10))
    .action(async (opts: { user: string; since?: string; limit?: number }) => {
      try {
        const query = new URLSearchParams({ user: opts.user });
        if (opts.since) query.set('since', opts.since);
        if (opts.limit) query.set('limit', String(opts.limit));
        outputSuccess(fixToHint(await getManagementHttp().get(`${BASE}/auth-attempts?${query.toString()}`)));
      } catch (err) { outputError(err); }
    });
}

