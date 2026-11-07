import { Command } from 'commander';
import { registerAccountCommands } from './commands/accounts.command.js';
import { registerAppCommands } from './commands/app.command.js';
import { registerAuthCommands } from './commands/auth.command.js';
import { registerBillingCommands } from './commands/billing.command.js';
import { registerCheckCommands } from './commands/check.command.js';
import type { Deps } from './commands/context.js';
import { registerFlagCommands } from './commands/flag.command.js';
import { registerKeyCommands } from './commands/key.command.js';
import { registerPlanCommands } from './commands/plan.command.js';

/**
 * The whole command tree. Kept apart from `cli.ts` (which reads the package
 * version) so tests build the real tree with fake dependencies.
 */
export function buildProgram(deps: Deps, version = '0.0.0'): Command {
  const program = new Command();
  program
    .name('bridge')
    .description('Set up your app on Bridge from the terminal: sign-in, apps and their addresses, keys, plans, Stripe and flags.')
    .version(version)
    .option('--issuer <url>', 'The Bridge App\'s issuer (env: BRIDGE_ISSUER; saved at sign-in)')
    .option('--app <id>', 'The app to act on (env: BRIDGE_APP; default: the one chosen with `bridge app use`)')
    .showHelpAfterError();
  registerAuthCommands(program, deps);
  registerAppCommands(program, deps);
  registerKeyCommands(program, deps);
  registerPlanCommands(program, deps);
  registerBillingCommands(program, deps);
  registerFlagCommands(program, deps);
  registerAccountCommands(program, deps);
  registerCheckCommands(program, deps);
  return program;
}
