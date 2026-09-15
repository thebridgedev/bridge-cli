/**
 * TBP-670 — `bridge stripe status` / `stripe connect` must read the field the
 * server actually returns (`stripeCredentialsAdded`), not auth-core's stale
 * `hasStripeCredentials`.
 *
 * The fixtures below are the server's response shape, copied key-for-key from
 * bridge-api `bridge-api-types/ts-client/platform/models/credentials-state.model.ts`
 * (origin/stage 01a08b0; last changed in 463182f, TBP-658) — the model both
 * `GET /v1/account/app/credentialsState` and `PUT /v1/account/app/credentials`
 * serialize. They deliberately do NOT carry `hasStripeCredentials`: the server
 * never sends it, so a test that includes it only proves the mock agrees with
 * the bug. Revert-proof: switching the command back to `state.hasStripeCredentials`
 * makes every `connected: true` assertion here fail.
 */

const getCredentialsState = jest.fn();
const getApp = jest.fn();
const updateCredentials = jest.fn();

jest.mock('../config.js', () => ({
  getManagementClient: () => ({
    app: { getCredentialsState, get: getApp, updateCredentials },
  }),
}));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputError: jest.fn() }));

import { Command } from 'commander';
import { outputSuccess, outputError } from '../output.js';
import { registerStripeCommands, type ServerCredentialsState } from '../commands/stripe.command.js';

/** Every key of the server's CredentialsStateModel, in its declaration order. */
const SERVER_MODEL_KEYS = [
  'stripeCredentialsAdded',
  'stripeWebhookConfigured',
  'azureMarketplaceCredentialsAdded',
  'azureAdSsoCredentialsAdded',
  'linkedinSsoCredentialsAdded',
  'googleSsoCredentialsAdded',
  'appleSsoCredentialsAdded',
  'githubSsoCredentialsAdded',
  'facebookSsoCredentialsAdded',
];

function serverState(overrides: Partial<ServerCredentialsState> = {}): ServerCredentialsState {
  return {
    stripeCredentialsAdded: true,
    stripeWebhookConfigured: true,
    azureMarketplaceCredentialsAdded: false,
    azureAdSsoCredentialsAdded: false,
    linkedinSsoCredentialsAdded: false,
    googleSsoCredentialsAdded: false,
    appleSsoCredentialsAdded: false,
    githubSsoCredentialsAdded: false,
    facebookSsoCredentialsAdded: false,
    ...overrides,
  };
}

async function run(...args: string[]): Promise<Record<string, unknown>> {
  const program = new Command();
  program.exitOverride();
  registerStripeCommands(program);
  await program.parseAsync(['node', 'bridge', 'stripe', ...args]);
  expect(outputError).not.toHaveBeenCalled();
  expect(outputSuccess).toHaveBeenCalledTimes(1);
  return (outputSuccess as jest.Mock).mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  getApp.mockResolvedValue({ stripeEnabled: true, stripeSetupStatus: 'completed' });
});

describe('fixture matches the server model (TBP-670)', () => {
  it('has exactly the server CredentialsStateModel keys and no hasStripeCredentials', () => {
    expect(Object.keys(serverState())).toEqual(SERVER_MODEL_KEYS);
    expect(serverState()).not.toHaveProperty('hasStripeCredentials');
  });
});

describe('bridge stripe status (TBP-670)', () => {
  it('reports connected when the server says stripeCredentialsAdded: true', async () => {
    getCredentialsState.mockResolvedValue(serverState());
    getApp.mockResolvedValue({
      stripeEnabled: true,
      stripeSetupStatus: 'completed',
      stripeLastWebhookAt: '2026-09-15T10:00:00.000Z',
      stripeLastWebhookRejectedAt: null,
    });

    const out = await run('status');

    expect(out.connected).toBe(true);
    expect(out.webhookConfigured).toBe(true);
    expect(out.webhookHealthy).toBe(true);
    expect(out.lastWebhookAt).toBe('2026-09-15T10:00:00.000Z');
    expect(out.message).toBe('Stripe is connected and its webhook is configured');
  });

  it('reports not connected when the server says stripeCredentialsAdded: false', async () => {
    getCredentialsState.mockResolvedValue(
      serverState({ stripeCredentialsAdded: false, stripeWebhookConfigured: false }),
    );

    const out = await run('status');

    expect(out.connected).toBe(false);
    expect(out.webhookHealthy).toBeNull();
    expect(out.message).toMatch(/^Stripe is not connected/);
  });

  it('flags a connected app whose webhook has no signing secret', async () => {
    getCredentialsState.mockResolvedValue(serverState({ stripeWebhookConfigured: false }));

    const out = await run('status');

    expect(out.connected).toBe(true);
    expect(out.webhookConfigured).toBe(false);
    expect(out.webhookHealthy).toBe(false);
    expect(out.message).toMatch(/webhook is not working/);
  });

  it('flags a rejection newer than the last verified event, with its reason', async () => {
    getCredentialsState.mockResolvedValue(serverState());
    getApp.mockResolvedValue({
      stripeSetupStatus: 'completed',
      stripeLastWebhookAt: '2026-09-14T10:00:00.000Z',
      stripeLastWebhookRejectedAt: '2026-09-15T10:00:00.000Z',
      stripeLastWebhookRejectionReason: 'signature_mismatch',
    });

    const out = await run('status');

    expect(out.webhookHealthy).toBe(false);
    expect(out.lastWebhookRejectionReason).toBe('signature_mismatch');
  });

  it('flags setup status failed and passes the reason through', async () => {
    getCredentialsState.mockResolvedValue(serverState());
    getApp.mockResolvedValue({ stripeSetupStatus: 'failed', stripeSetupError: 'no webhook secret' });

    const out = await run('status');

    expect(out.webhookHealthy).toBe(false);
    expect(out.setupStatus).toBe('failed');
    expect(out.setupError).toBe('no webhook secret');
  });

  it('does not call an older API broken when it omits stripeWebhookConfigured', async () => {
    const { stripeWebhookConfigured: _omitted, ...older } = serverState();
    getCredentialsState.mockResolvedValue(older);
    getApp.mockResolvedValue({ stripeEnabled: true, stripeSetupStatus: 'completed' });

    const out = await run('status');

    expect(out.connected).toBe(true);
    expect(out.webhookConfigured).toBeNull();
    expect(out.webhookHealthy).toBeNull();
    expect(out.message).toMatch(/^Stripe is connected \(webhook health not reported/);
  });
});

describe('bridge stripe connect (TBP-670)', () => {
  it('reports connected from the PUT response stripeCredentialsAdded', async () => {
    updateCredentials.mockResolvedValue(serverState());

    const out = await run('connect', '--secret-key', 'sk_test_x', '--publishable-key', 'pk_test_x');

    expect(updateCredentials).toHaveBeenCalledWith({
      stripeSecretKey: 'sk_test_x',
      stripePublicKey: 'pk_test_x',
    });
    expect(out).toEqual({
      connected: true,
      webhookConfigured: true,
      message: 'Stripe connected successfully',
    });
  });

  it('warns when keys are saved but the webhook is not configured', async () => {
    updateCredentials.mockResolvedValue(serverState({ stripeWebhookConfigured: false }));

    const out = await run('connect', '--secret-key', 'sk_test_x', '--publishable-key', 'pk_test_x');

    expect(out.connected).toBe(true);
    expect(out.message).toMatch(/webhook is not configured/);
  });

  it('reports not confirmed when stripeCredentialsAdded is false', async () => {
    updateCredentials.mockResolvedValue(serverState({ stripeCredentialsAdded: false }));

    const out = await run('connect', '--secret-key', 'sk_test_x', '--publishable-key', 'pk_test_x');

    expect(out.connected).toBe(false);
    expect(out.message).toMatch(/did not confirm/);
  });
});
