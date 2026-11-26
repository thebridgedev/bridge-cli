import { Command } from 'commander';
import { registerAccountCommands } from './commands/accounts.command.js';
import { registerAppCommands } from './commands/app.command.js';
import { registerAuthCommands } from './commands/auth.command.js';
import { registerBillingCommands } from './commands/billing.command.js';
import { registerCheckCommands } from './commands/check.command.js';
import { registerCompatCommands } from './commands/compat.command.js';
import type { Deps } from './commands/context.js';
import { registerDiagnoseCommands } from './commands/diagnose.command.js';
import { registerFlagCommands } from './commands/flag.command.js';
import { registerGuideCommands } from './commands/guide.command.js';
import { registerInfoCommands } from './commands/info.command.js';
import { registerKeyCommands } from './commands/key.command.js';
import { registerPlanCommands } from './commands/plan.command.js';
import { registerSettingsCommands } from './commands/settings.command.js';
import { registerUpdateCommands } from './commands/update.command.js';
import { configDir } from './config.js';
import { noticeOff, startUpdateCheck } from './core/updates.js';

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
    .option('--server <url>', 'Bridge\'s address, such as https://api.example.com: the CLI reads its sign-in issuer from it (env: BRIDGE_SERVER; saved at sign-in; default: https://api.thebridge.dev)')
    .option('--issuer <url>', 'The Bridge App\'s issuer, instead of --server (env: BRIDGE_ISSUER; saved at sign-in)')
    .option('--app <id>', 'The app to act on (env: BRIDGE_APP; default: the one chosen with `bridge app use`)')
    .showHelpAfterError();
  registerAuthCommands(program, deps);
  registerAppCommands(program, deps);
  registerKeyCommands(program, deps);
  registerPlanCommands(program, deps);
  registerBillingCommands(program, deps);
  registerFlagCommands(program, deps);
  registerAccountCommands(program, deps);
  // After the account commands: it adds `role set-default` to the `role` group.
  registerCompatCommands(program, deps);
  // After the auth commands: it adds `auth methods|config|password-policy` to the `auth` group.
  registerSettingsCommands(program, deps);
  // After the settings commands: it adds `event auth-attempts` to the `event` group.
  registerDiagnoseCommands(program, deps);
  registerInfoCommands(program, deps);
  registerGuideCommands(program, deps);
  registerCheckCommands(program, deps);
  registerUpdateCommands(program, deps, version);
  addUpdateNotice(program, deps, version);
  return program;
}

/**
 * The notice that a newer CLI is out: checked in the background while a command runs, printed on stderr after its
 * output, at most once a day. Never for `bridge update` itself, and never with `BRIDGE_NO_UPDATE_NOTICE=true`.
 */
function addUpdateNotice(program: Command, deps: Deps, version: string): void {
  const updates = deps.updates;
  if (updates === undefined) return;
  let check: ReturnType<typeof startUpdateCheck> | undefined;
  program.hook('preAction', (_program, command) => {
    if (noticeOff(deps.env) || (command.name() === 'update' && command.parent === program)) return;
    check = startUpdateCheck({
      version,
      dir: configDir(deps.env),
      registry: updates.registry,
      now: deps.now ?? Date.now,
      deadlineMs: updates.deadlineMs,
      graceMs: updates.graceMs,
    });
  });
  program.hook('postAction', async () => {
    const running = check;
    check = undefined;
    const notice = await running?.finish().catch(() => null);
    if (notice) deps.io.info(notice);
  });
}
