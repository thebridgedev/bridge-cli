/**
 * TBP-663 — `bridge setup sso` / `bridge setup communication` must send only
 * fields the server declares.
 *
 * The field lists below are copied key-for-key from bridge-api (origin/stage
 * 526c3de): microservices/account/nebulr-api/app/dto/update-credentials-request.dto.ts
 * (`PUT /v1/account/app/credentials`) and update-app-request.dto.ts
 * (`PUT /v1/account/app`). Both run under forbidNonWhitelisted, so any key not
 * listed is a 400. They are the server's lists, not the CLI's: a test built
 * from the CLI's own table would only prove the table agrees with itself.
 *
 * Revert-proof: the previous command called `workflows.setupSSO` /
 * `workflows.setupCommunication` (azure as `azureClientId`, email as
 * `sendgridApiKey`). Those are mocked here to throw, so restoring the old
 * command fails every success case; restoring the old field derivation fails
 * the "declared by the server" assertions.
 */

const updateCredentials = jest.fn();
const updateApp = jest.fn();
const getApp = jest.fn();
const setupSSO = jest.fn(() => { throw new Error('workflows.setupSSO must not be used (TBP-663)'); });
const setupCommunication = jest.fn(() => { throw new Error('workflows.setupCommunication must not be used (TBP-663)'); });

jest.mock('../config.js', () => ({
  getManagementClient: () => ({
    app: { updateCredentials, update: updateApp, get: getApp },
    workflows: { setupSSO, setupCommunication },
  }),
}));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputError: jest.fn() }));

import { Command } from 'commander';
import { outputSuccess, outputError } from '../output.js';
import { registerSetupCommands } from '../commands/setup.command.js';

/** bridge-api UpdateCredentialsRequestDto, in declaration order. */
const SERVER_CREDENTIAL_FIELDS = [
  'stripeSecretKey', 'stripePublicKey',
  'microsoftAzureMarketplaceClientId', 'microsoftAzureMarketplaceClientSecret', 'microsoftAzureMarketplaceTenantId',
  'googleClientId', 'googleClientSecret',
  'linkedinClientId', 'linkedinClientSecret',
  'githubClientId', 'githubClientSecret',
  'facebookClientId', 'facebookClientSecret',
  'microsoftAzureADClientId', 'microsoftAzureADClientSecret', 'microsoftAzureADTenantId',
  'appleClientId', 'appleTeamId', 'appleKeyId', 'applePrivateKey',
];

/** bridge-api UpdateAppRequestDto, in declaration order. */
const SERVER_APP_FIELDS = [
  'name', 'apiUrl', 'uiUrl', 'webhookUrl', 'webhookEventFilter', 'webhookEnabled', 'logo',
  'tenantSelfSignup', 'redirectUris', 'allowedOrigins', 'defaultCallbackUri', 'onboardingFlow',
  'websiteUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'emailSenderName', 'emailSenderEmail',
  'paymentsAutoRedirect', 'passkeysEnabled', 'stripeEnabled', 'currency', 'mfaEnabled',
  'magicLinkEnabled', 'googleSsoEnabled', 'linkedinSsoEnabled', 'azureAdSsoEnabled',
  'appleSsoEnabled', 'githubSsoEnabled', 'facebookSsoEnabled', 'azureMarketplaceEnabled',
  'accessTokenTTL', 'refreshTokenTTL', 'allowedTokenPrivileges',
];

function expectDeclared(body: object, declared: string[]) {
  for (const key of Object.keys(body)) expect(declared).toContain(key);
}

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerSetupCommands(program);
  await program.parseAsync(['node', 'bridge', 'setup', ...args]);
}

async function succeed(...args: string[]): Promise<Record<string, unknown>> {
  await run(...args);
  expect(outputError).not.toHaveBeenCalled();
  expect(outputSuccess).toHaveBeenCalledTimes(1);
  return (outputSuccess as jest.Mock).mock.calls[0][0];
}

async function refuse(...args: string[]): Promise<{ code: string; message: string }> {
  await run(...args);
  expect(outputSuccess).not.toHaveBeenCalled();
  expect(outputError).toHaveBeenCalledTimes(1);
  // Refused before anything is sent.
  expect(updateCredentials).not.toHaveBeenCalled();
  expect(updateApp).not.toHaveBeenCalled();
  return (outputError as jest.Mock).mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  updateCredentials.mockResolvedValue({});
  updateApp.mockImplementation(async (body: Record<string, unknown>) => ({ ...body }));
  getApp.mockResolvedValue({ defaultCallbackUri: 'https://auth.example.com/auth/callback' });
});

describe('bridge setup sso (TBP-663)', () => {
  it.each([
    ['google', { googleClientId: 'id', googleClientSecret: 'secret' }, { googleSsoEnabled: true }],
    ['github', { githubClientId: 'id', githubClientSecret: 'secret' }, { githubSsoEnabled: true }],
    ['linkedin', { linkedinClientId: 'id', linkedinClientSecret: 'secret' }, { linkedinSsoEnabled: true }],
    ['facebook', { facebookClientId: 'id', facebookClientSecret: 'secret' }, { facebookSsoEnabled: true }],
  ])('%s sends the server field names and enables the provider', async (provider, credentials, enable) => {
    const out = await succeed('sso', '--provider', provider, '--client-id', 'id', '--client-secret', 'secret');

    expect(updateCredentials).toHaveBeenCalledWith(credentials);
    expect(updateApp).toHaveBeenCalledWith(enable);
    expectDeclared(updateCredentials.mock.calls[0][0], SERVER_CREDENTIAL_FIELDS);
    expectDeclared(updateApp.mock.calls[0][0], SERVER_APP_FIELDS);
    expect(out).toMatchObject({ provider, enabled: true, callbackUrl: 'https://auth.example.com/auth/callback' });
    expect(setupSSO).not.toHaveBeenCalled();
  });

  it('azure sends microsoftAzureAD* including the Entra tenant id', async () => {
    await succeed('sso', '--provider', 'azure', '--client-id', 'id', '--client-secret', 'secret', '--tenant-id', 'tid');

    expect(updateCredentials).toHaveBeenCalledWith({
      microsoftAzureADClientId: 'id',
      microsoftAzureADClientSecret: 'secret',
      microsoftAzureADTenantId: 'tid',
    });
    expect(updateApp).toHaveBeenCalledWith({ azureAdSsoEnabled: true });
    expectDeclared(updateCredentials.mock.calls[0][0], SERVER_CREDENTIAL_FIELDS);
    expectDeclared(updateApp.mock.calls[0][0], SERVER_APP_FIELDS);
  });

  it('azure without --tenant-id is refused', async () => {
    const err = await refuse('sso', '--provider', 'azure', '--client-id', 'id', '--client-secret', 'secret');
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toMatch(/azure needs --tenant-id/);
  });

  it('--tenant-id on a non-azure provider is refused', async () => {
    const err = await refuse('sso', '--provider', 'google', '--client-id', 'id', '--client-secret', 'secret', '--tenant-id', 'tid');
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it.each(['saml', 'oidc'])('%s is refused as not supported by the Bridge API', async (provider) => {
    const err = await refuse('sso', '--provider', provider, '--client-id', 'id', '--client-secret', 'secret');
    expect(err.code).toBe('SSO_PROVIDER_NOT_SUPPORTED');
    expect(err.message).toMatch(new RegExp(`"${provider}" is not supported by the Bridge API`));
  });

  it.each([
    ['--metadata-url', 'https://idp.example.com/metadata'],
    ['--discovery-url', 'https://idp.example.com/.well-known/openid-configuration'],
  ])('%s is refused with an explanation, not sent', async (flag, value) => {
    const err = await refuse('sso', '--provider', 'google', '--client-id', 'id', '--client-secret', 'secret', flag, value);
    expect(err.code).toBe('SSO_PROVIDER_NOT_SUPPORTED');
    expect(err.message).toMatch(new RegExp(`${flag} was removed`));
  });

  it('an unknown provider is refused', async () => {
    const err = await refuse('sso', '--provider', 'myspace', '--client-id', 'id', '--client-secret', 'secret');
    expect(err.code).toBe('SSO_PROVIDER_NOT_SUPPORTED');
  });
});

describe('bridge setup communication (TBP-663)', () => {
  it('sets only the sender name and address on the app', async () => {
    const out = await succeed('communication', '--from-address', 'noreply@acme.com', '--from-name', 'Acme');

    expect(updateApp).toHaveBeenCalledWith({ emailSenderEmail: 'noreply@acme.com', emailSenderName: 'Acme' });
    expectDeclared(updateApp.mock.calls[0][0], SERVER_APP_FIELDS);
    expect(updateCredentials).not.toHaveBeenCalled();
    expect(setupCommunication).not.toHaveBeenCalled();
    expect(out).toMatchObject({ configured: true, emailSenderEmail: 'noreply@acme.com', emailSenderName: 'Acme' });
  });

  it('can set the name alone', async () => {
    await succeed('communication', '--from-name', 'Acme');
    expect(updateApp).toHaveBeenCalledWith({ emailSenderName: 'Acme' });
  });

  it.each([
    [['--provider', 'sendgrid', '--from-address', 'noreply@acme.com']],
    [['--api-key', 'SG.x', '--from-address', 'noreply@acme.com']],
  ])('refuses the removed provider / API key options: %j', async (args) => {
    const err = await refuse('communication', ...args);
    expect(err.code).toBe('EMAIL_PROVIDER_NOT_SUPPORTED');
    expect(err.message).toMatch(/Bridge sends all email through its own provider/);
  });

  it('refuses an invalid address', async () => {
    const err = await refuse('communication', '--from-address', 'not-an-email');
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it('refuses when there is nothing to set', async () => {
    const err = await refuse('communication');
    expect(err.code).toBe('INVALID_ARGUMENT');
  });
});

describe('help text (TBP-663)', () => {
  function help(sub: string): string {
    const program = new Command();
    registerSetupCommands(program);
    const setup = program.commands.find((c) => c.name() === 'setup')!;
    // Collapse commander's column wrapping so a phrase split across lines still matches.
    return setup.commands.find((c) => c.name() === sub)!.helpInformation().replace(/\s+/g, ' ');
  }

  it('sso offers only the supported providers and --tenant-id', () => {
    const text = help('sso');
    expect(text).toMatch(/google, github, linkedin, facebook, azure/);
    expect(text).toMatch(/--tenant-id/);
    expect(text).not.toMatch(/--metadata-url|--discovery-url/);
  });

  it('communication no longer advertises a provider or API key', () => {
    const text = help('communication');
    expect(text).not.toMatch(/--api-key|--provider|sendgrid/i);
  });
});
