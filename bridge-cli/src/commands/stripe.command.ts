import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerStripeCommands(program: Command): void {
  const stripe = program.command('stripe').description('Manage Stripe integration');

  stripe.command('status')
    .description('Show whether Stripe credentials are configured')
    .action(async () => {
      try {
        const state = await getManagementClient().app.getCredentialsState();
        outputSuccess({
          connected: state.hasStripeCredentials,
          message: state.hasStripeCredentials
            ? 'Stripe is connected'
            : 'Stripe is not connected — run: bridge stripe connect --secret-key sk_... --publishable-key pk_...',
        });
      } catch (err) { outputError(err); }
    });

  stripe.command('connect')
    .description('Set Stripe API credentials')
    .requiredOption('--secret-key <key>', 'Stripe secret key (sk_live_... or sk_test_...)')
    .requiredOption('--publishable-key <key>', 'Stripe publishable key (pk_live_... or pk_test_...)')
    .action(async (opts) => {
      try {
        const state = await getManagementClient().app.updateCredentials({
          stripeSecretKey: opts.secretKey,
          stripePublicKey: opts.publishableKey,
        });
        outputSuccess({
          connected: state.hasStripeCredentials,
          message: state.hasStripeCredentials
            ? 'Stripe connected successfully'
            : 'Credentials saved but Stripe did not confirm — check your keys and try again',
        });
      } catch (err) { outputError(err); }
    });
}
