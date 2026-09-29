import { Command } from 'commander';
import { ConfigError, getManagementClient, resolveSelectedCredential, resetManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { updateCredential, type StoredCredentials } from '../credentials.js';
import {
  createWorkspaceClient,
  resolveAppSelector,
  type WorkspaceAppsResponse,
} from '../auth/workspace-client.js';

export function registerAppCommands(program: Command): void {
  const app = program.command('app').description('Manage app configuration');

  // TBP-769 — one login, every app of the workspace (MCP parity).
  app.command('list')
    .description('List the apps your login covers, marking the home app and the current one')
    .action(async () => {
      try { outputSuccess(await runAppList()); }
      catch (err) { outputError(err); }
    });

  app.command('use <id|name>')
    .description('Make another app of your workspace login the default for every command (local, no re-login)')
    .action(async (selector: string) => {
      try { outputSuccess(await runAppUse(selector)); }
      catch (err) { outputError(err); }
    });

  app.command('create')
    .description('Create a new app in your workspace')
    .requiredOption('--name <name>', 'App name')
    .option('--callback-url <url>', 'OAuth callback URL to register on the new app')
    .option('--use', 'Also make the new app the current one (like `bridge app use`)')
    .action(async (opts: { name: string; callbackUrl?: string; use?: boolean }) => {
      try { outputSuccess(await runAppCreate(opts)); }
      catch (err) { outputError(err); }
    });

  app.command('get')
    .description('Get current app configuration')
    .action(async () => {
      try { outputSuccess(await getManagementClient().app.get()); }
      catch (err) { outputError(err); }
    });

  app.command('update')
    .description('Update app settings')
    .option('--name <name>', 'App name')
    .option('--api-url <url>', 'API URL')
    .option('--ui-url <url>', "Your app's base URL. Links in Bridge emails (invites, password resets, payment notices) open here when your backend calls the API without an Origin header. Must also be listed in --allowed-origins")
    .option('--webhook-url <url>', 'Webhook URL')
    .option('--tenant-self-signup <bool>', 'Allow tenant self-signup', parseBool)
    .option('--mfa-enabled <bool>', 'Enable MFA', parseBool)
    .option('--passkeys-enabled <bool>', 'Enable passkeys', parseBool)
    .option('--magic-link-enabled <bool>', 'Enable magic links', parseBool)
    .option('--payments-auto-redirect <bool>', 'Force new users to pick a plan before entering the app (billing paywall)', parseBool)
    .option('--redirect-uris <uris>', 'Comma-separated list of allowed OAuth callback URIs', parseList)
    .option('--allowed-origins <origins>', 'Comma-separated list of allowed CORS origins', parseList)
    .option('--default-callback-uri <uri>', 'Default OAuth callback URI')
    .action(async (opts) => {
      try {
        const data = stripUndefined({
          name: opts.name,
          apiUrl: opts.apiUrl,
          uiUrl: opts.uiUrl,
          webhookUrl: opts.webhookUrl,
          tenantSelfSignup: opts.tenantSelfSignup,
          mfaEnabled: opts.mfaEnabled,
          passkeysEnabled: opts.passkeysEnabled,
          magicLinkEnabled: opts.magicLinkEnabled,
          paymentsAutoRedirect: opts.paymentsAutoRedirect,
          redirectUris: opts.redirectUris,
          allowedOrigins: opts.allowedOrigins,
          defaultCallbackUri: opts.defaultCallbackUri,
        });
        outputSuccess(await getManagementClient().app.update(data));
      } catch (err) { outputError(err); }
    });

  const redirectUris = app
    .command('redirect-uris')
    .description('Manage allowed OAuth callback URIs without replacing the whole list');

  redirectUris.command('list')
    .description('List registered redirect URIs')
    .action(async () => {
      try {
        const current = await getManagementClient().app.get();
        outputSuccess({ redirectUris: current.redirectUris ?? [] });
      } catch (err) { outputError(err); }
    });

  redirectUris.command('add <url>')
    .description('Register a redirect URI (existing entries are kept)')
    .action(async (url: string) => {
      try {
        validateRedirectUri(url);
        const client = getManagementClient();
        const current = (await client.app.get()).redirectUris ?? [];
        if (current.includes(url)) {
          outputSuccess({ added: false, message: `Already registered: ${url}`, redirectUris: current });
          return;
        }
        const next = [...current, url];
        await client.app.update({ redirectUris: next });
        outputSuccess({ added: true, redirectUris: next });
      } catch (err) { outputError(err); }
    });

  redirectUris.command('remove <url>')
    .description('Remove a registered redirect URI')
    .action(async (url: string) => {
      try {
        const client = getManagementClient();
        const current = (await client.app.get()).redirectUris ?? [];
        if (!current.includes(url)) {
          throw new Error(
            `Redirect URI not registered: ${url}. Registered URIs: ${current.length ? current.join(', ') : '(none)'}`,
          );
        }
        const next = current.filter((u) => u !== url);
        await client.app.update({ redirectUris: next });
        outputSuccess({ removed: true, redirectUris: next });
      } catch (err) { outputError(err); }
    });
}

/** The stored login these commands work with; BRIDGE_API_KEY cannot list apps. */
function loginContext(): { key: string; creds: StoredCredentials; baseUrl: string } {
  const selected = resolveSelectedCredential();
  if (!selected.creds || !selected.key) {
    throw Object.assign(
      new ConfigError('App selection needs a login from `bridge auth login`; BRIDGE_API_KEY is bound to one app.'),
      { hint: 'Run `bridge auth login` (it covers every app of the workspace by default).' },
    );
  }
  return { key: selected.key, creds: selected.creds, baseUrl: selected.baseUrl };
}

function workspaceClient(ctx: { creds: StoredCredentials; baseUrl: string }) {
  return createWorkspaceClient({ baseUrl: ctx.baseUrl, loginToken: ctx.creds.apiKey });
}

/** Current = the locally chosen app of this login, else its home app. */
function currentAppId(creds: StoredCredentials): string {
  return creds.appAccess === 'workspace' && creds.currentApp ? creds.currentApp.id : creds.app.id;
}

/** Learn the login's scope from the server (credentials from before TBP-769 lack it). */
function rememberScope(key: string, creds: StoredCredentials, scope: WorkspaceAppsResponse['scope']): StoredCredentials {
  const appAccess = scope === 'workspace' ? 'workspace' : 'app';
  return creds.appAccess === appAccess ? creds : updateCredential(key, { appAccess });
}

async function runAppList() {
  const ctx = loginContext();
  const res = await workspaceClient(ctx).listApps();
  const creds = rememberScope(ctx.key, ctx.creds, res.scope);
  const current = currentAppId(creds);
  return {
    scope: res.scope,
    homeAppId: res.homeAppId,
    currentAppId: current,
    apps: res.apps.map((a) => ({ id: a.id, name: a.name, home: a.home, current: a.id === current })),
  };
}

async function runAppUse(selector: string) {
  const ctx = loginContext();
  const home = ctx.creds.app;
  const lower = selector.trim().toLowerCase();

  let target: { id: string; name: string };
  if (selector.trim() === home.id || lower === home.name.toLowerCase()) {
    target = home;
  } else {
    const res = await workspaceClient(ctx).listApps();
    rememberScope(ctx.key, ctx.creds, res.scope);
    if (res.scope !== 'workspace') {
      throw Object.assign(
        new ConfigError(
          `This login covers only the app ${home.name} (${home.id}), so it cannot switch to "${selector}".`,
        ),
        {
          code: 'APP_NOT_IN_CONNECTION',
          hint:
            'Run `bridge auth login` again and choose "Every app in <workspace>" on the consent ' +
            'screen; one login then covers every app and `bridge app use` switches between them.',
        },
      );
    }
    target = resolveAppSelector(selector, res.apps);
  }

  const isHome = target.id === home.id;
  updateCredential(ctx.key, { currentApp: isHome ? undefined : { id: target.id, name: target.name } });
  resetManagementClient();
  return {
    currentApp: { id: target.id, name: target.name, home: isHome },
    message: isHome
      ? `Now using the home app ${target.name} (${target.id}).`
      : `Now using ${target.name} (${target.id}). Commands act on it until \`bridge app use\` again; \`--app\` overrides it for one command.`,
  };
}

async function runAppCreate(opts: { name: string; callbackUrl?: string; use?: boolean }) {
  const ctx = loginContext();
  const res = await workspaceClient(ctx).createApp({
    name: opts.name,
    ...(opts.callbackUrl ? { callbackUrl: opts.callbackUrl } : {}),
  });
  let current = false;
  if (opts.use) {
    // A create that succeeded proves the login spans the workspace.
    updateCredential(ctx.key, {
      appAccess: 'workspace',
      currentApp: res.app.id === ctx.creds.app.id ? undefined : { id: res.app.id, name: res.app.name },
    });
    resetManagementClient();
    current = true;
  }
  return { app: res.app, current };
}

function validateRedirectUri(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Invalid redirect URI: "${value}" is not an absolute URL (expected e.g. https://app.example.com/auth/oauth-callback).`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid redirect URI: "${value}" must use http or https.`);
  }
}

function parseBool(val: string): boolean {
  return val === 'true';
}

function parseList(val: string): string[] {
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
