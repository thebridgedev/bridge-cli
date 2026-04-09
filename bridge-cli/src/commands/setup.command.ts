import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import type { SSOProvider } from '@nebulr-group/bridge-auth-core';

export function registerSetupCommands(program: Command): void {
  const setup = program.command('setup').description('Run setup workflows (multi-step operations)');

  setup.command('sso')
    .description('Enable an SSO provider and get callback URL')
    .requiredOption('--provider <provider>', 'SSO provider: google, azure, github, linkedin, facebook, saml, oidc')
    .option('--client-id <id>', 'OAuth client ID')
    .option('--client-secret <secret>', 'OAuth client secret')
    .option('--metadata-url <url>', 'SAML metadata URL')
    .option('--discovery-url <url>', 'OIDC discovery URL')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().workflows.setupSSO({
          provider: opts.provider as SSOProvider,
          config: {
            clientId: opts.clientId,
            clientSecret: opts.clientSecret,
            metadataUrl: opts.metadataUrl,
            discoveryUrl: opts.discoveryUrl,
          },
        }));
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
    .description('Configure email/communication provider')
    .requiredOption('--provider <provider>', 'Provider name (e.g., sendgrid)')
    .requiredOption('--api-key <key>', 'Provider API key')
    .option('--from-address <email>', 'Sender email address')
    .option('--from-name <name>', 'Sender name')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().workflows.setupCommunication({
          provider: opts.provider,
          config: {
            apiKey: opts.apiKey,
            fromAddress: opts.fromAddress,
            fromName: opts.fromName,
          },
        }));
      } catch (err) { outputError(err); }
    });
}
