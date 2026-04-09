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
          redirectUris: opts.redirectUris,
          allowedOrigins: opts.allowedOrigins,
          defaultCallbackUri: opts.defaultCallbackUri,
        });
        outputSuccess(await getManagementClient().app.update(data));
      } catch (err) { outputError(err); }
    });
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
