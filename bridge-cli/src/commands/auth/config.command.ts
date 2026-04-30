/**
 * `bridge auth config|mfa|password-policy` — the original auth subcommands
 * that pre-date TBP-113. Kept as-is; just lifted out of `auth.command.ts`
 * so the file stays small and testable.
 */
import type { Command } from 'commander';
import { getManagementClient } from '../../config.js';
import { outputSuccess, outputError } from '../../output.js';

export function registerAuthConfigCommands(auth: Command): void {
  auth
    .command('config')
    .description('Get current auth configuration')
    .action(async () => {
      try {
        const app = await getManagementClient().app.get();
        outputSuccess({
          mfaEnabled: app.mfaEnabled,
          passkeysEnabled: app.passkeysEnabled,
          magicLinkEnabled: app.magicLinkEnabled,
          googleSsoEnabled: app.googleSsoEnabled,
          azureAdSsoEnabled: app.azureAdSsoEnabled,
          githubSsoEnabled: app.githubSsoEnabled,
          linkedinSsoEnabled: app.linkedinSsoEnabled,
          facebookSsoEnabled: app.facebookSsoEnabled,
          appleSsoEnabled: app.appleSsoEnabled,
          onboardingFlow: app.onboardingFlow,
          tenantSelfSignup: app.tenantSelfSignup,
          accessTokenTTL: app.accessTokenTTL,
          refreshTokenTTL: app.refreshTokenTTL,
        });
      } catch (err) {
        outputError(err);
      }
    });

  auth
    .command('mfa')
    .description('Enable or disable MFA')
    .requiredOption('--enabled <bool>', 'true or false', (v) => v === 'true')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().app.update({ mfaEnabled: opts.enabled }));
      } catch (err) {
        outputError(err);
      }
    });

  auth
    .command('password-policy')
    .description('Update access token TTL')
    .option('--access-token-ttl <seconds>', 'Access token TTL in seconds', parseInt)
    .option('--refresh-token-ttl <seconds>', 'Refresh token TTL in seconds', parseInt)
    .action(async (opts) => {
      try {
        const data = Object.fromEntries(
          Object.entries({
            accessTokenTTL: opts.accessTokenTtl,
            refreshTokenTTL: opts.refreshTokenTtl,
          }).filter(([, v]) => v !== undefined),
        );
        outputSuccess(await getManagementClient().app.update(data));
      } catch (err) {
        outputError(err);
      }
    });
}
