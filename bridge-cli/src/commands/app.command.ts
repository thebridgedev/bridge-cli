import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerAppCommands(program: Command): void {
  const app = program.command('app').description('Manage app configuration');

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
    .option('--ui-url <url>', 'UI URL')
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
