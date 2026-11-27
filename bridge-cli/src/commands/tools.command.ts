import type { Command } from 'commander';
import { apps } from '../api/apps.js';
import { signInSettings, userConnections, type ToolsSettings, type UserConnection } from '../api/settings.js';
import { CliError } from '../core/errors.js';
import { action, type Context, type Deps } from './context.js';

/**
 * Assistants and CLI: which AI assistants may connect to the app's MCP endpoints and
 * whether the app's CLI may sign in with a short code (`app tools`), the extra MCP endpoints on other domains
 * (`app mcp`), and a user's connected tools for the app's admins (`user connections|disconnect|sign-out-everywhere`).
 * Browser sign-in for the app's CLI and MCP sign-in are always on and need nothing here. Each command asks Bridge,
 * which checks everything again; an older Bridge without these fields is said, never faked.
 */

/** The assistants Bridge knows by name, under the client ids their connections use. */
export const KNOWN_ASSISTANTS: Readonly<Record<string, string>> = { claude: 'Claude', chatgpt: 'ChatGPT', cursor: 'Cursor' };
const MAX_ASSISTANTS = 50;
const MAX_MCP = 10;

export const SHORT_CODE_WARNING =
  'Attackers abuse short codes ("device code phishing"): they start a sign-in, send someone the code and are signed in as that person once it is entered. Switch it on only if your users sign in on machines without a browser.';

const OLDER_SERVER = (what: string) =>
  new CliError('not-offered', `This Bridge server has no ${what} yet.`, { hint: 'It comes with a newer Bridge. Nothing was changed.' });

function onOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on' || value === 'true') return true;
  if (value === 'off' || value === 'false') return false;
  throw new CliError('invalid', `${flag} is on or off: ${value}`);
}

/** Why an assistant id would be refused, or null: a client id, or an https client metadata document URL. */
export function assistantProblem(id: string): string | null {
  if (id.trim() === '') return 'An assistant is its client id (claude, chatgpt, cursor, a registered id) or its client metadata document URL.';
  if (id.includes('://')) {
    try {
      const url = new URL(id);
      if (url.protocol !== 'https:') return `A client metadata document URL uses https: ${id}`;
      if (url.hash !== '') return `A client metadata document URL has no fragment: ${id}`;
    } catch {
      return `Not a valid URL: ${id}`;
    }
    return null;
  }
  return /\s/.test(id) ? `A client id has no spaces: ${id}` : null;
}

/** Why an extra MCP endpoint would be refused, or null: https, no wildcard, query or fragment. */
export function mcpProblem(url: string): string | null {
  if (url.includes('*')) return 'An MCP endpoint is one URL: no wildcard.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a valid URL: ${url}`;
  }
  if (parsed.protocol !== 'https:') return 'An MCP endpoint uses https.';
  if (parsed.search !== '' || url.includes('?')) return 'An MCP endpoint has no query (?).';
  if (parsed.hash !== '' || url.includes('#')) return 'An MCP endpoint has no fragment (#).';
  return null;
}

const toolsView = (tools: ToolsSettings) => ({
  anyAssistant: tools.anyAssistant,
  assistants: tools.assistants.map((id) => ({ id, name: KNOWN_ASSISTANTS[id] ?? id })),
  shortCode: tools.shortCode,
  browserSignIn: 'always on',
  mcpSignIn: 'always on',
});

const connectionView = (each: UserConnection) => ({
  id: each.id,
  name: each.client.name,
  kind: each.kind === 'cli' ? 'command-line tool' : 'assistant',
  workspace: each.workspace,
  connectedAt: each.signedInAt,
  lastUsedAt: each.lastUsedAt,
  mayDelete: each.delete,
});

/** The User a command names: an email (found across the app, as `user passkeys` does) or a user id as given. */
async function userOf(ctx: Context, who: string) {
  const { c, appId } = await ctx.forApp();
  if (!who.includes('@')) return { c, appId, user: { id: who, email: null as string | null } };
  const found = (await c.person<{ id: string; email: string }[]>('usersList', { params: { appId }, query: { email: who } })).body.find((each) => each.email.toLowerCase() === who.toLowerCase());
  if (found === undefined) throw new CliError('not-found', `No user with the email ${who} in this app.`, { hint: '`bridge user list --tenant-id <workspace>` shows a workspace\'s users.' });
  return { c, appId, user: { id: found.id, email: found.email as string | null } };
}

/** A user's connections; an older server without the route says so. */
async function connectionsOf(ctx: Context, who: string) {
  const found = await userOf(ctx, who);
  try {
    return { ...found, list: await userConnections.list(found.c, found.appId, found.user.id) };
  } catch (error) {
    if (error instanceof CliError && error.kind === 'not-found') {
      throw new CliError('not-offered', 'This Bridge server does not list a user\'s connected tools, or does not know this user.', { hint: 'Check the user id with `bridge user list`; connected tools come with a newer Bridge.' });
    }
    throw error;
  }
}

export function registerToolsCommands(program: Command, deps: Deps): void {
  const app = program.commands.find((each) => each.name() === 'app') ?? program.command('app');

  const tools = app.command('tools').description("Assistants and CLI: which AI assistants may connect to the app's MCP endpoints, and sign-in with a short code. Browser sign-in for your CLI and MCP sign-in are always on");
  tools.action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      const settings = await signInSettings.get(c, appId);
      if (settings.tools === undefined) throw OLDER_SERVER('Assistants and CLI settings');
      ctx.io.result({ tools: toolsView(settings.tools) });
    }),
  );
  tools
    .command('set')
    .description('Change who may connect and how the CLI may sign in')
    .option('--any-assistant <on|off>', 'on (the default): any assistant can connect once the user agrees; off: only the assistants listed with --assistant')
    .option('--assistant <id...>', 'The assistants allowed when --any-assistant is off: claude, chatgpt, cursor, a registered client id or a client metadata URL (replaces the list)')
    .option('--short-code <on|off>', 'Allow sign-in with a short code on machines without a browser (off by default)')
    .action(
      action(deps, async (ctx, opts: { anyAssistant?: string; assistant?: string[]; shortCode?: string }) => {
        const anyAssistant = onOff(opts.anyAssistant, '--any-assistant');
        const shortCode = onOff(opts.shortCode, '--short-code');
        const assistants = opts.assistant === undefined ? undefined : [...new Set(opts.assistant.map((id) => id.trim()))];
        if (anyAssistant === undefined && shortCode === undefined && assistants === undefined) {
          throw new CliError('invalid', 'Nothing to change.', { hint: 'Give --any-assistant on|off, --assistant <id>... or --short-code on|off. `bridge app tools` shows them.' });
        }
        for (const id of assistants ?? []) {
          const problem = assistantProblem(id);
          if (problem !== null) throw new CliError('invalid', `${problem} Nothing was changed.`);
        }
        if (assistants !== undefined && assistants.length > MAX_ASSISTANTS) throw new CliError('invalid', `At most ${MAX_ASSISTANTS} assistants can be listed. Nothing was changed.`);
        const { c, appId } = await ctx.forApp();
        const before = await signInSettings.get(c, appId);
        if (before.tools === undefined) throw OLDER_SERVER('Assistants and CLI settings');
        if (anyAssistant === false && (assistants ?? before.tools.assistants).length === 0) ctx.io.info('No assistant is listed, so no AI assistant can connect to your app\'s MCP endpoints.');
        if (shortCode === true && !before.tools.shortCode) ctx.io.info(SHORT_CODE_WARNING);
        const change = { ...(anyAssistant === undefined ? {} : { anyAssistant }), ...(assistants === undefined ? {} : { assistants }), ...(shortCode === undefined ? {} : { shortCode }) };
        const after = await signInSettings.update(c, appId, { tools: change });
        ctx.io.result({ tools: after.tools === undefined ? null : toolsView(after.tools) });
      }),
    );

  const mcp = app.command('mcp').description("Extra MCP endpoints on other domains. MCP endpoints on the app's own addresses (and localhost in development) need nothing");
  const endpointsOf = async (ctx: Context) => {
    const { c, appId } = await ctx.forApp();
    const found = await apps.get(c, appId);
    const list = found.yourApp?.mcp;
    if (list === undefined) throw OLDER_SERVER('extra MCP endpoints');
    return { c, appId, list, app: found };
  };
  mcp.command('list').description('The extra MCP endpoints').action(
    action(deps, async (ctx) => {
      ctx.io.result({ mcp: (await endpointsOf(ctx)).list });
    }),
  );
  mcp
    .command('add <url>')
    .description('Add an MCP endpoint on another domain, such as https://mcp.other-domain.com/mcp (https, no wildcard, query or fragment; at most 10)')
    .action(
      action(deps, async (ctx, url: string) => {
        const problem = mcpProblem(url);
        if (problem !== null) throw new CliError('invalid', `${problem} Nothing was changed.`);
        const { c, appId, list, app: found } = await endpointsOf(ctx);
        const origin = new URL(url).origin;
        if (found.addresses.some((each) => each.uses.includes('browser-origin') && each.url === origin)) {
          ctx.io.info(`${origin} is one of the app's addresses, so its MCP endpoints need nothing. Nothing was changed.`);
          ctx.io.result({ mcp: list, changed: false });
          return;
        }
        if (list.includes(url)) {
          ctx.io.info(`${url} is listed already.`);
          ctx.io.result({ mcp: list, changed: false });
          return;
        }
        if (list.length >= MAX_MCP) throw new CliError('invalid', `At most ${MAX_MCP} extra MCP endpoints can be listed. Nothing was changed.`);
        const changed = await apps.update(c, appId, { mcp: [...list, url] });
        ctx.io.result({ mcp: changed.yourApp?.mcp ?? [...list, url], changed: true });
      }),
    );
  mcp
    .command('remove <url>')
    .description('Remove an extra MCP endpoint')
    .action(
      action(deps, async (ctx, url: string) => {
        const { c, appId, list } = await endpointsOf(ctx);
        if (!list.includes(url)) throw new CliError('not-found', `${url} is not listed.`, { hint: '`bridge app mcp list` shows the list.' });
        const changed = await apps.update(c, appId, { mcp: list.filter((each) => each !== url) });
        ctx.io.result({ mcp: changed.yourApp?.mcp ?? list.filter((each) => each !== url), changed: true });
      }),
    );

  const user = program.commands.find((each) => each.name() === 'user') ?? program.command('user').description("The app's users");
  if (!user.aliases().includes('users')) user.alias('users');
  user
    .command('connections <user>')
    .description("The user's connected tools (the app's CLI, AI assistants), by email or user id: name, kind, workspace, connected, last used")
    .action(
      action(deps, async (ctx, who: string) => {
        const { user: found, list } = await connectionsOf(ctx, who);
        ctx.io.result({ user: found.email ?? found.id, connections: list.map(connectionView) });
      }),
    );
  user
    .command('disconnect <user> [connectionId]')
    .description('Disconnect one of the user\'s tools, or all with --all. It can no longer renew and its calls are refused')
    .option('--all', 'Disconnect every tool of the user (their browser sessions stay)')
    .option('--dry-run', 'Say what would be disconnected, and change nothing')
    .option('--yes', 'Confirm')
    .action(
      action(deps, async (ctx, who: string, connectionId: string | undefined, opts: { all?: boolean; dryRun?: boolean; yes?: boolean }) => {
        if ((connectionId === undefined) === (opts.all !== true)) throw new CliError('invalid', 'Name one connection id, or give --all.', { hint: `\`bridge user connections ${who}\` shows them.` });
        const { c, appId, user: found, list } = await connectionsOf(ctx, who);
        const targets = opts.all === true ? list : list.filter((each) => each.id === connectionId);
        if (targets.length === 0 && opts.all !== true) throw new CliError('not-found', `${found.email ?? found.id} has no connected tool ${connectionId as string}.`, { hint: `\`bridge user connections ${who}\` shows them.` });
        const view = targets.map(connectionView);
        if (opts.dryRun === true) return ctx.io.result({ dryRun: true, user: found.email ?? found.id, connections: view });
        if (opts.yes !== true) throw new CliError('invalid', 'Confirm with --yes. `--dry-run` shows what would be disconnected first.');
        if (opts.all === true) {
          const answer = await userConnections.endAll(c, appId, found.id);
          return ctx.io.result({ disconnected: answer.ended, user: found.email ?? found.id, connections: view });
        }
        await userConnections.end(c, appId, found.id, connectionId as string);
        ctx.io.result({ disconnected: 1, user: found.email ?? found.id, connections: view });
      }),
    );
  user
    .command('sign-out-everywhere <user>')
    .description('End every session of the user: browser sign-ins and every connected tool. They sign in again')
    .option('--yes', 'Confirm')
    .action(
      action(deps, async (ctx, who: string, opts: { yes?: boolean }) => {
        if (opts.yes !== true) throw new CliError('invalid', 'Signing a user out everywhere needs --yes. Nothing was changed.');
        const { c, appId, user: found } = await userOf(ctx, who);
        const answer = await userConnections.signOutEverywhere(c, appId, found.id);
        ctx.io.result({ signedOut: true, ended: answer.ended, user: found.email ?? found.id });
      }),
    );
}
