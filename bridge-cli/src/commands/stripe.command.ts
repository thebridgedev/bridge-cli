import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

/*
 * TBP-670: read the fields the SERVER returns, not the ones auth-core's
 * `CredentialsState` type declares. auth-core (<= 0.4.6) types the response of
 * `GET /v1/account/app/credentialsState` and `PUT /v1/account/app/credentials`
 * as `{ hasStripeCredentials, hasSendgridCredentials }`, but bridge-api answers
 * both with `CredentialsStateModel` (bridge-api-types/ts-client/platform/models/
 * credentials-state.model.ts), whose Stripe field is `stripeCredentialsAdded`.
 * Trusting the client type made `connected` undefined, so `stripe status`
 * always said "not connected". Same bug as TBP-656 (MCP); auth-core's type is
 * corrected in TBP-663, and until that ships this local type is the contract.
 */
export interface ServerCredentialsState {
  stripeCredentialsAdded: boolean;
  /** TBP-658. Optional: older account APIs do not send it. */
  stripeWebhookConfigured?: boolean;
  azureMarketplaceCredentialsAdded: boolean;
  azureAdSsoCredentialsAdded: boolean;
  linkedinSsoCredentialsAdded: boolean;
  googleSsoCredentialsAdded: boolean;
  appleSsoCredentialsAdded: boolean;
  githubSsoCredentialsAdded: boolean;
  facebookSsoCredentialsAdded: boolean;
}

/** Webhook health fields on the app response (TBP-658). All optional: older APIs omit them. */
export interface ServerAppStripeState {
  stripeSetupStatus?: 'pending' | 'completed' | 'failed' | null;
  stripeSetupError?: string | null;
  stripeLastWebhookAt?: string | null;
  stripeLastWebhookRejectedAt?: string | null;
  stripeLastWebhookRejectionReason?: string | null;
}

/** `true` only when the server confirms stored Stripe keys; never undefined. */
export function stripeConnectedFrom(state: unknown): boolean {
  return (state as Partial<ServerCredentialsState> | null | undefined)?.stripeCredentialsAdded === true;
}

/** `null` when the API does not report it (older account API), so absence is not read as broken. */
export function stripeWebhookConfiguredFrom(state: unknown): boolean | null {
  const value = (state as Partial<ServerCredentialsState> | null | undefined)?.stripeWebhookConfigured;
  return typeof value === 'boolean' ? value : null;
}

export interface StripeStatus {
  connected: boolean;
  webhookConfigured: boolean | null;
  webhookHealthy: boolean | null;
  lastWebhookAt: string | null;
  lastWebhookRejectedAt: string | null;
  lastWebhookRejectionReason: string | null;
  setupStatus: string | null;
  setupError: string | null;
  message: string;
}

const CONNECT_HINT = 'run: bridge stripe connect --secret-key sk_... --publishable-key pk_...';
const REPAIR_HINT =
  'Checkout still works, but subscription changes, cancellations and payment failures are not ' +
  'reaching Bridge. Repair: re-run `bridge setup payments` with the same keys, or use "Repair ' +
  'webhook" in the Bridge admin payment settings.';

/*
 * Mirrors bridge-api's `AppService._stripeWebhookUnhealthy` plus the two
 * explicit failure signals. `null` = the API gave us nothing to judge by.
 */
function webhookHealthy(
  configured: boolean | null,
  app: ServerAppStripeState,
): boolean | null {
  if (configured === false || app.stripeSetupStatus === 'failed') return false;
  const rejectedAt = app.stripeLastWebhookRejectedAt;
  if (rejectedAt) {
    const lastAt = app.stripeLastWebhookAt;
    if (!lastAt || new Date(rejectedAt).getTime() > new Date(lastAt).getTime()) return false;
  }
  return configured;
}

export function stripeStatusFrom(state: unknown, app: unknown): StripeStatus {
  const a = (app ?? {}) as ServerAppStripeState;
  const connected = stripeConnectedFrom(state);
  const webhookConfigured = stripeWebhookConfiguredFrom(state);
  const healthy = connected ? webhookHealthy(webhookConfigured, a) : null;

  let message: string;
  if (!connected) message = `Stripe is not connected — ${CONNECT_HINT}`;
  else if (healthy === false) message = `Stripe is connected, but its webhook is not working. ${REPAIR_HINT}`;
  else if (healthy === null) message = 'Stripe is connected (webhook health not reported by this API)';
  else message = 'Stripe is connected and its webhook is configured';

  return {
    connected,
    webhookConfigured,
    webhookHealthy: healthy,
    lastWebhookAt: a.stripeLastWebhookAt ?? null,
    lastWebhookRejectedAt: a.stripeLastWebhookRejectedAt ?? null,
    lastWebhookRejectionReason: a.stripeLastWebhookRejectionReason ?? null,
    setupStatus: a.stripeSetupStatus ?? null,
    setupError: a.stripeSetupError ?? null,
    message,
  };
}

export function registerStripeCommands(program: Command): void {
  const stripe = program.command('stripe').description('Manage Stripe integration');

  stripe.command('status')
    .description('Show whether Stripe credentials are configured and whether its webhook works')
    .action(async () => {
      try {
        const client = getManagementClient();
        const [state, app] = await Promise.all([
          client.app.getCredentialsState(),
          client.app.get(),
        ]);
        outputSuccess(stripeStatusFrom(state, app));
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
        const connected = stripeConnectedFrom(state);
        const webhookConfigured = stripeWebhookConfiguredFrom(state);
        let message = connected
          ? 'Stripe connected successfully'
          : 'Credentials saved but Stripe did not confirm — check your keys and try again';
        if (connected && webhookConfigured === false) {
          message += '. Warning: the Stripe webhook is not configured — run `bridge stripe status` for details';
        }
        outputSuccess({ connected, webhookConfigured, message });
      } catch (err) { outputError(err); }
    });
}
