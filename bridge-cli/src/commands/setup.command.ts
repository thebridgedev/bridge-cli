import { Command, Option } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

/*
 * TBP-663 — `setup sso` and `setup communication` talk to the app service
 * (`app.updateCredentials` / `app.update` / `app.get`) directly instead of
 * `workflows.setupSSO` / `workflows.setupCommunication`.
 *
 * Why not the workflows: in auth-core <= 0.7.0-beta.0 they send fields the
 * API rejects under forbidNonWhitelisted — azure as `azureClientId`, saml/oidc
 * as `samlMetadataUrl` / `oidcDiscoveryUrl`, email as `sendgridApiKey` — so
 * both commands 400'd. auth-core main (#34) fixed them but changed their
 * signatures and throws on the options this CLI used to pass. The app service
 * has the same shape in both, so calling it with the server's own field names
 * behaves identically whichever auth-core is installed.
 *
 * Field names are the server's: bridge-api
 * microservices/account/nebulr-api/app/dto/update-credentials-request.dto.ts
 * and update-app-request.dto.ts. Same table as auth-core's `setupSSO` and the
 * MCP `setup_sso` tool. `setup-command.test.ts` pins them to those DTOs.
 */

export const SSO_PROVIDERS = {
  google: { clientId: 'googleClientId', clientSecret: 'googleClientSecret', enable: 'googleSsoEnabled' },
  github: { clientId: 'githubClientId', clientSecret: 'githubClientSecret', enable: 'githubSsoEnabled' },
  linkedin: { clientId: 'linkedinClientId', clientSecret: 'linkedinClientSecret', enable: 'linkedinSsoEnabled' },
  facebook: { clientId: 'facebookClientId', clientSecret: 'facebookClientSecret', enable: 'facebookSsoEnabled' },
  azure: {
    clientId: 'microsoftAzureADClientId',
    clientSecret: 'microsoftAzureADClientSecret',
    tenantId: 'microsoftAzureADTenantId',
    enable: 'azureAdSsoEnabled',
  },
} as const;

export type SupportedSsoProvider = keyof typeof SSO_PROVIDERS;

type ProviderFields = (typeof SSO_PROVIDERS)[SupportedSsoProvider];
type CredentialField = ProviderFields['clientId'] | ProviderFields['clientSecret'] | 'microsoftAzureADTenantId';
type SsoEnableField = ProviderFields['enable'];

const SUPPORTED = Object.keys(SSO_PROVIDERS).join(', ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Carries a machine-readable `code`, which `outputError` reports. */
export class SetupError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SetupError';
  }
}

const NOT_SAVED = ' Nothing was saved.';
const invalid = (message: string) => new SetupError(message + NOT_SAVED, 'INVALID_ARGUMENT');

function isSupported(provider: string): provider is SupportedSsoProvider {
  return Object.prototype.hasOwnProperty.call(SSO_PROVIDERS, provider);
}

export interface SetupSsoOptions {
  provider: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  metadataUrl?: string;
  discoveryUrl?: string;
}

export async function setupSso(opts: SetupSsoOptions) {
  const provider = String(opts.provider).toLowerCase();
  if (!isSupported(provider)) {
    throw new SetupError(
      provider === 'saml' || provider === 'oidc'
        ? `SSO provider "${provider}" is not supported by the Bridge API: it has no fields for SAML or OIDC ` +
          `connections. Set them up in the Bridge admin UI. Supported here: ${SUPPORTED}.${NOT_SAVED}`
        : `Unknown SSO provider "${provider}". Supported: ${SUPPORTED}.${NOT_SAVED}`,
      'SSO_PROVIDER_NOT_SUPPORTED',
    );
  }
  for (const [flag, value] of [['--metadata-url', opts.metadataUrl], ['--discovery-url', opts.discoveryUrl]] as const) {
    if (value !== undefined) {
      throw new SetupError(
        `${flag} was removed: the Bridge API has no field for it (SAML and OIDC are set up in the Bridge admin UI).${NOT_SAVED}`,
        'SSO_PROVIDER_NOT_SUPPORTED',
      );
    }
  }
  if (!opts.clientId || !opts.clientSecret) {
    throw invalid('--client-id and --client-secret are required (from the provider console).');
  }

  const fields = SSO_PROVIDERS[provider];
  const credentials: Partial<Record<CredentialField, string>> = {
    [fields.clientId]: opts.clientId,
    [fields.clientSecret]: opts.clientSecret,
  };
  if ('tenantId' in fields) {
    if (!opts.tenantId) {
      throw invalid('azure needs --tenant-id: the Directory (tenant) ID from the Entra ID app registration.');
    }
    credentials[fields.tenantId] = opts.tenantId;
  } else if (opts.tenantId !== undefined) {
    throw invalid(`--tenant-id applies to azure only, not "${provider}".`);
  }

  const mgmt = getManagementClient();
  await mgmt.app.updateCredentials(credentials);
  const enable: Partial<Record<SsoEnableField, boolean>> = { [fields.enable]: true };
  await mgmt.app.update(enable);
  const app = await mgmt.app.get();

  return { provider, enabled: true, callbackUrl: app.defaultCallbackUri, app };
}

export interface SetupCommunicationOptions {
  fromAddress?: string;
  fromName?: string;
  provider?: string;
  apiKey?: string;
}

export async function setupCommunication(opts: SetupCommunicationOptions) {
  if (opts.provider !== undefined || opts.apiKey !== undefined) {
    throw new SetupError(
      '--provider and --api-key were removed: Bridge sends all email through its own provider, so there is ' +
        'no provider or API key to configure (the Bridge API has never accepted one). ' +
        `Pass only --from-address and/or --from-name.${NOT_SAVED}`,
      'EMAIL_PROVIDER_NOT_SUPPORTED',
    );
  }
  const { fromAddress, fromName } = opts;
  if (fromAddress === undefined && fromName === undefined) {
    throw invalid('Nothing to set: pass --from-address, --from-name, or both.');
  }
  if (fromAddress !== undefined && !EMAIL.test(fromAddress)) {
    throw invalid('--from-address must be an email address, e.g. "no-reply@example.com".');
  }
  if (fromName !== undefined && fromName.trim() === '') {
    throw invalid('--from-name must not be empty.');
  }

  const update: { emailSenderEmail?: string; emailSenderName?: string } = {};
  if (fromAddress !== undefined) update.emailSenderEmail = fromAddress;
  if (fromName !== undefined) update.emailSenderName = fromName;
  const app = await getManagementClient().app.update(update);

  return {
    configured: true,
    emailSenderEmail: app.emailSenderEmail ?? null,
    emailSenderName: app.emailSenderName ?? null,
    app,
  };
}

/** Accepted only to refuse it with an explanation instead of commander's bare "unknown option". */
const removed = (flags: string, description: string) => new Option(flags, description).hideHelp();

export function registerSetupCommands(program: Command): void {
  const setup = program.command('setup').description('Run setup workflows (multi-step operations)');

  setup.command('sso')
    .description('Enable an SSO login provider and get the callback URL to register with it')
    .requiredOption('--provider <provider>', `SSO provider: ${SUPPORTED} (SAML/OIDC are set up in the Bridge admin UI)`)
    .requiredOption('--client-id <id>', 'OAuth client ID from the provider console')
    .requiredOption('--client-secret <secret>', 'OAuth client secret from the provider console')
    .option('--tenant-id <id>', 'azure only, required: Entra ID Directory (tenant) ID (not a Bridge tenant)')
    .addOption(removed('--metadata-url <url>', 'removed: SAML is not supported by the Bridge API'))
    .addOption(removed('--discovery-url <url>', 'removed: OIDC is not supported by the Bridge API'))
    .action(async (opts) => {
      try {
        outputSuccess(await setupSso(opts));
      } catch (err) { outputError(err); }
    });

  setup.command('payments')
    .description('Connect Stripe and optionally create plans')
    .requiredOption('--stripe-key <key>', 'Stripe secret key')
    .option('--stripe-public-key <key>', 'Stripe public key')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().workflows.setupPayments({
          stripeSecretKey: opts.stripeKey,
          stripePublicKey: opts.stripePublicKey,
        }));
      } catch (err) { outputError(err); }
    });

  setup.command('communication')
    .description("Set the sender name and address of your app's emails (sent through Bridge's own email provider)")
    .option('--from-address <email>', 'Sender email address. A new address is verified by email before Bridge uses it')
    .option('--from-name <name>', 'Sender display name')
    .addOption(removed('--provider <provider>', 'removed: email goes through Bridge\'s own provider'))
    .addOption(removed('--api-key <key>', 'removed: email goes through Bridge\'s own provider'))
    .action(async (opts) => {
      try {
        outputSuccess(await setupCommunication(opts));
      } catch (err) { outputError(err); }
    });
}
