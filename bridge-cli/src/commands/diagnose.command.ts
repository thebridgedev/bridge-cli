import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { apps, type App } from '../api/apps.js';
import { listEvents } from '../api/settings.js';
import { CliError } from '../core/errors.js';
import { action, type Deps } from './context.js';
import { sinceOf } from './settings.command.js';

/**
 * `bridge doctor` (also `diagnose`): checks a project's Bridge settings against the real app and lists every difference
 * with its fix, from env files it reads here: a wrong app or issuer, a server of another Bridge, a callback that is not a
 * sign-in return, an origin that is not allowed, a secret in a browser bundle. Names are checked, and values only where
 * they are addresses and ids; a secret's value is never printed. `event auth-attempts` lists one person's sign-ins and
 * why each failure failed.
 */

const ISSUER_VARS = ['PUBLIC_BRIDGE_ISSUER', 'VITE_BRIDGE_ISSUER', 'NEXT_PUBLIC_BRIDGE_ISSUER', 'BRIDGE_ISSUER'] as const;
const APP_ID_VARS = ['VITE_BRIDGE_APP_ID', 'NEXT_PUBLIC_BRIDGE_APP_ID', 'REACT_APP_BRIDGE_APP_ID', 'BRIDGE_APP_ID'] as const;
const BASE_URL_VARS = ['VITE_BRIDGE_API_BASE_URL', 'NEXT_PUBLIC_BRIDGE_API_BASE_URL', 'BRIDGE_API_BASE_URL', 'BRIDGE_BASE_URL'] as const;
const CALLBACK_VARS = ['VITE_BRIDGE_CALLBACK_URL', 'REACT_APP_BRIDGE_CALLBACK_URL', 'PUBLIC_BRIDGE_CALLBACK_URL'] as const;
const PUBLIC_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'REACT_APP_', 'PUBLIC_', 'NUXT_PUBLIC_', 'EXPO_PUBLIC_'];
const DEFAULT_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const FRAMEWORKS = ['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express'] as const;
type Framework = (typeof FRAMEWORKS)[number];
const REQUIRED: Readonly<Record<Framework, readonly (readonly string[])[]>> = {
  svelte: [ISSUER_VARS.slice(0, 2)],
  react: [ISSUER_VARS.slice(1, 2)],
  nextjs: [ISSUER_VARS.slice(2, 3)],
  angular: [],
  nestjs: [['BRIDGE_ISSUER']],
  express: [['BRIDGE_ISSUER']],
};

const isSecretName = (name: string) => /API_KEY|SECRET|TOKEN|PASSWORD/i.test(name);
const trimSlash = (value: string) => value.trim().replace(/\/+$/, '');
const originOf = (url: string): string | undefined => {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

/** An env file's `NAME=value` lines, comments and blanks left out, quotes taken off. Later files win. */
export function parseEnv(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || (match[1] as string).startsWith('#')) continue;
    let value = match[2] as string;
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    found[match[1] as string] = value;
  }
  return found;
}

/** Whether the app lists `origin` as a browser origin: exactly, `https://*.example.com` for a subdomain, `http://localhost:*` for any port. */
export function originAllowed(allowed: readonly string[], origin: string): boolean {
  return allowed.some((entry) => {
    if (entry === origin) return true;
    if (entry.endsWith(':*')) return origin.startsWith(`${entry.slice(0, -2)}:`) || origin === entry.slice(0, -2);
    const wildcard = /^(https?):\/\/\*\.(.+)$/.exec(entry);
    if (wildcard === null) return false;
    try {
      const url = new URL(origin);
      return url.protocol === `${wildcard[1] as string}:` && url.host.endsWith(`.${wildcard[2] as string}`);
    } catch {
      return false;
    }
  });
}

interface Difference {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly variable?: string;
  readonly found?: string;
  readonly expected?: string;
  readonly message: string;
  readonly fix: string;
}

/** The framework, from the variable names, or from the project's package.json dependencies. */
function inferFramework(names: readonly string[], dependencies: readonly string[]): Framework | undefined {
  for (const framework of FRAMEWORKS) if (dependencies.some((each) => each.endsWith(`bridge-${framework}`))) return framework;
  if (names.some((name) => name.startsWith('NEXT_PUBLIC_'))) return 'nextjs';
  if (names.some((name) => name.startsWith('VITE_') || name.startsWith('PUBLIC_'))) return 'svelte';
  if (names.includes('BRIDGE_APP_ID') || names.includes('BRIDGE_ISSUER')) return 'nestjs';
  return undefined;
}

/** The checks, as data: the app, the variables read, the server the CLI reached. Pure. */
export function diagnose(app: App, env: Readonly<Record<string, string>>, framework: Framework | undefined, server: string): { ok: boolean; differences: Difference[] } {
  const has = (name: string) => (env[name] ?? '').trim() !== '';
  const value = (name: string) => (env[name] ?? '').trim();
  const differences: Difference[] = [];
  const addresses = app.addresses ?? [];
  const returns = addresses.filter((each) => each.uses.includes('sign-in-return')).map((each) => each.url);
  const origins = addresses.filter((each) => each.uses.includes('browser-origin')).map((each) => each.url);
  const issuer = typeof app.trust?.issuer === 'string' ? trimSlash(app.trust.issuer) : undefined;

  for (const name of Object.keys(env)) {
    if (isSecretName(name) && PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      differences.push({ code: 'SECRET_IN_PUBLIC_VAR', severity: 'error', variable: name, message: `${name} is compiled into the browser bundle, so anyone can read the secret it holds.`, fix: `Rename it to a server-only variable, read it only in server code, and rotate the key it exposed: \`bridge key revoke <id>\` then \`bridge key create\`.` });
    }
  }
  for (const name of ISSUER_VARS.filter(has)) {
    const found = trimSlash(value(name));
    if (issuer !== undefined && found !== issuer) {
      differences.push({ code: 'ISSUER_MISMATCH', severity: 'error', variable: name, found, expected: issuer, message: `${name} is ${found}, but this app's issuer is ${issuer}. Sign-ins would go to another app or another Bridge.`, fix: `Set ${name}=${issuer}, or run \`bridge app setup\`, which writes it. If the project is meant to use another app, run this check against that app (\`--app <id>\`).` });
    }
  }
  for (const name of APP_ID_VARS.filter(has)) {
    if (value(name) !== app.id) {
      differences.push({ code: 'APP_ID_MISMATCH', severity: 'error', variable: name, found: value(name), expected: app.id, message: `${name} names app ${value(name)}, but this check is running against app ${app.id} (${app.name}).`, fix: `Set ${name}=${app.id}, or run this check against that app (\`--app ${value(name)}\`).` });
    }
  }
  for (const name of BASE_URL_VARS.filter(has)) {
    if (trimSlash(value(name)) !== server) {
      differences.push({ code: 'BASE_URL_MISMATCH', severity: 'error', variable: name, found: trimSlash(value(name)), expected: server, message: `${name} points at ${trimSlash(value(name))}, but this app lives on the Bridge at ${server}. Sign-ins would go to a different Bridge, where this app does not exist or has other settings.`, fix: `Set ${name}=${server}.` });
    }
  }
  for (const name of CALLBACK_VARS.filter(has)) {
    const callback = value(name);
    if (!returns.includes(callback)) {
      differences.push({ code: 'CALLBACK_NOT_REGISTERED', severity: 'error', variable: name, found: callback, message: `${name} is ${callback}, which is not one of the app's sign-in returns, so the sign-in redirect is refused.`, fix: `Register it: \`bridge app address add ${callback} --use sign-in-return\`.` });
    }
    const origin = originOf(callback);
    if (origin !== undefined && !originAllowed(origins, origin)) {
      differences.push({ code: 'ORIGIN_NOT_ALLOWED', severity: 'error', variable: name, found: origin, message: `The callback's origin ${origin} is not one of the app's browser origins, so calls from the app's pages are refused.`, fix: `Add it: \`bridge app address add ${origin} --use browser-origin\`.` });
    }
  }
  if (returns.length === 0) {
    differences.push({ code: 'NO_CALLBACK_URI', severity: 'error', message: 'The app has no sign-in return address, so every sign-in that returns to the app is refused.', fix: "Add your project's callback with `bridge app address add <url> --use sign-in-return`." });
  } else if (app.defaultReturn === null || app.defaultReturn === undefined) {
    differences.push({ code: 'NO_DEFAULT_CALLBACK', severity: 'warning', message: 'The app has no default sign-in return, so a sign-in that names none has nowhere to return to.', fix: 'Choose one: `bridge app default-return <url>`.' });
  }
  if (framework !== undefined) {
    for (const alternatives of REQUIRED[framework]) {
      if (!alternatives.some(has) && !APP_ID_VARS.some(has)) {
        differences.push({ code: 'MISSING_VAR', severity: 'error', variable: alternatives[0] as string, ...(issuer === undefined ? {} : { expected: issuer }), message: `${framework} projects read ${alternatives.join(' or ')}, and it is not set.`, fix: `Set ${alternatives[0] as string}${issuer === undefined ? '' : `=${issuer}`}, or run \`bridge app setup\`.` });
      }
    }
  }
  return { ok: differences.every((each) => each.severity !== 'error'), differences };
}

async function readEnvFiles(dir: string, files: readonly string[] | undefined): Promise<{ env: Record<string, string>; read: string[]; dependencies: string[] }> {
  const env: Record<string, string> = {};
  const read: string[] = [];
  for (const file of files ?? DEFAULT_ENV_FILES) {
    const path = resolve(dir, file);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      if (files !== undefined) throw new CliError('invalid', `Could not read ${path}.`);
      continue;
    }
    Object.assign(env, parseEnv(text));
    read.push(path);
  }
  let dependencies: string[] = [];
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
    dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  } catch {
    dependencies = [];
  }
  return { env, read, dependencies };
}

export function registerDiagnoseCommands(program: Command, deps: Deps): void {
  program
    .command('doctor')
    .alias('diagnose')
    .description("Check this project's Bridge settings against the app, listing every difference with its fix")
    .option('--env-file <path...>', `Env file(s) to read, later ones winning (default: ${DEFAULT_ENV_FILES.join(', ')} when present)`)
    .option('--framework <name>', `One of: ${FRAMEWORKS.join(', ')} (default: found from package.json or the variable names)`)
    .option('--dir <path>', 'The project directory (default: here)')
    .action(
      action(deps, async (ctx, opts: { envFile?: string[]; framework?: string; dir?: string }) => {
        if (opts.framework !== undefined && !(FRAMEWORKS as readonly string[]).includes(opts.framework)) throw new CliError('invalid', `${opts.framework} is not a framework: ${FRAMEWORKS.join(', ')}.`);
        const { c, appId } = await ctx.forApp();
        const app = await apps.get(c, appId);
        const { env, read, dependencies } = await readEnvFiles(resolve(opts.dir ?? '.'), opts.envFile);
        const framework = (opts.framework as Framework | undefined) ?? inferFramework(Object.keys(env), dependencies);
        const server = new URL(await ctx.issuer()).origin;
        const { ok, differences } = diagnose(app, env, framework, server);
        ctx.io.result({ app: { id: app.id, name: app.name }, framework: framework ?? null, server, filesRead: read, checkedVariables: Object.keys(env).filter((name) => [...ISSUER_VARS, ...APP_ID_VARS, ...BASE_URL_VARS, ...CALLBACK_VARS].includes(name as never) || isSecretName(name)).sort(), ok, differences, ...(framework === 'angular' ? { notes: ['bridge-angular is configured in code (provider config), not from environment variables.'] } : {}) });
        if (!ok) ctx.io.setExitCode(1);
      }),
    );

  const event = program.commands.find((each) => each.name() === 'event') as Command;
  event
    .command('auth-attempts')
    .description("A person's recent sign-in attempts, newest first, each failure with its reason and a fix")
    .requiredOption('--user <email|id>', "The person's email address, or their user id")
    .option('--since <duration>', 'How far back: 24h, 7d, 2w or an ISO date')
    .option('--limit <n>', 'Most attempts to return (default 20, at most 100)', (value) => Number.parseInt(value, 10))
    .action(
      action(deps, async (ctx, opts: { user: string; since?: string; limit?: number }) => {
        const needle = opts.user.trim();
        const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
        const byEmail = needle.includes('@');
        if (!byEmail && !/^[0-9a-f]{24}$/i.test(needle)) throw new CliError('invalid', `"${needle}" is neither an email address nor a user id.`, { hint: 'Give the email, such as jane@example.com.' });
        const { c, appId } = await ctx.forApp();
        const from = opts.since === undefined ? undefined : sinceOf(opts.since, deps.now?.() ?? Date.now());
        const found = byEmail ? ((await c.person<{ id: string; email: string; suspended?: boolean; workspaces?: { status: string }[] }[]>('usersList', { params: { appId }, query: { email: needle } })).body[0] ?? null) : null;
        const userId = byEmail ? (found?.id ?? null) : needle;
        const attempts: { at: string; method: string | null; tenantId: string | null; outcome: 'success' | 'failure'; reason?: string; explanation?: string; fix?: string }[] = [];
        if (userId !== null) {
          const window = from === undefined ? {} : { from };
          const [failed, signedIn] = await Promise.all([listEvents(c, appId, { ...window, type: 'identity.sign_in_failed', limit: 500 }), listEvents(c, appId, { ...window, type: 'identity.signed_in', userId, limit })]);
          for (const each of failed) {
            if (each.data['user'] === userId) attempts.push({ at: each.time, method: 'password', tenantId: null, outcome: 'failure', reason: 'WRONG_PASSWORD', explanation: 'The password did not match.', fix: 'Check the password, or send the person a password reset (forgot password on the sign-in page).' });
          }
          for (const each of signedIn) {
            const methods = Array.isArray(each.data['methods']) ? (each.data['methods'] as string[]) : [];
            attempts.push({ at: each.time, method: methods.includes('pwd') ? 'password' : (methods[0] ?? null), tenantId: each.workspaceId, outcome: 'success' });
          }
        }
        attempts.sort((a, b) => b.at.localeCompare(a.at));
        const shown = attempts.slice(0, limit);
        const notes: string[] = [];
        if (byEmail && found === null) notes.push('No user with this email exists in this app. Sign-ins tried on an address with no account are logged without the address, so they cannot be listed here.');
        if (shown.length === 0 && (found !== null || !byEmail)) notes.push('No sign-in attempts recorded in this window. Attempts reach the log a few seconds after they happen.');
        ctx.io.result({
          user: { query: needle, exists: byEmail ? found !== null : null, userId, email: found?.email ?? (byEmail ? needle.toLowerCase() : null), activeWorkspaces: found?.workspaces === undefined ? null : found.workspaces.filter((each) => each.status === 'active').length, suspended: found?.suspended ?? null },
          since: from ?? null,
          attempts: shown,
          summary: { total: shown.length, failures: shown.filter((each) => each.outcome !== 'success').length, lastOutcome: shown[0]?.outcome ?? null, ...(notes.length === 0 ? {} : { note: notes.join(' ') }) },
          notAvailable: ['Refusals other than a wrong password (a paused or locked address, a suspended person, a workspace they may not enter) are not in the app\'s log yet.'],
        });
      }),
    );
}
