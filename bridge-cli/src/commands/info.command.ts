import type { Command } from 'commander';
import { roles } from '../api/accounts.js';
import { apps } from '../api/apps.js';
import { plans } from '../api/billing.js';
import { flags } from '../api/flags.js';
import { signInSettings } from '../api/settings.js';
import { action, type Deps } from './context.js';

/** `bridge info`: what the app is, in one read each (for people and for coding assistants): the 0.x commands of the name. */
export function registerInfoCommands(program: Command, deps: Deps): void {
  const info = program.command('info').description("Read the app's configuration: its record, sign-in setup, flags, plans and roles");
  info.command('app').description("The app's record and its sign-in settings").action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result({ app: await apps.get(c, appId), signIn: await signInSettings.get(c, appId) });
    }),
  );
  info.command('auth-config').description('How people sign in: the methods, the token lifetimes and the password rules').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await signInSettings.get(c, appId));
    }),
  );
  info.command('flags').description('Every flag with its state').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.list(c, appId));
    }),
  );
  info.command('plans').description('The plans').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await plans.list(c, appId, false));
    }),
  );
  info.command('roles').description('The roles and the privileges each holds').action(
    action(deps, async (ctx) => {
      ctx.io.result(await roles.list(await ctx.door()));
    }),
  );
}
