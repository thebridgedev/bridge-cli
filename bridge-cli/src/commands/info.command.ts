import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerInfoCommands(program: Command): void {
  const info = program.command('info').description('Get contextual information (for AI agents)');

  info.command('app')
    .description('Full app configuration snapshot')
    .action(async () => {
      try { outputSuccess(await getManagementClient().app.get()); }
      catch (err) { outputError(err); }
    });

  info.command('auth-config')
    .description('Current authentication configuration')
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
          stripeEnabled: app.stripeEnabled,
          tenantSelfSignup: app.tenantSelfSignup,
          onboardingFlow: app.onboardingFlow,
        });
      } catch (err) { outputError(err); }
    });

  info.command('flags')
    .description('All feature flags with current state')
    .action(async () => {
      try { outputSuccess(await getManagementClient().flags.list()); }
      catch (err) { outputError(err); }
    });

  info.command('plans')
    .description('Subscription plans')
    .action(async () => {
      try { outputSuccess(await getManagementClient().plans.list()); }
      catch (err) { outputError(err); }
    });

  info.command('roles')
    .description('Access roles and privileges')
    .action(async () => {
      try { outputSuccess(await getManagementClient().roles.list()); }
      catch (err) { outputError(err); }
    });
}
