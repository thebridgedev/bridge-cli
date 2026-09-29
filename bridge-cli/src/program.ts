import type { Command } from 'commander';
import { prepareAppContext, setAppOverride, setProfileOverride } from './config.js';
import { outputError } from './output.js';
import { registerAppCommands } from './commands/app.command.js';
import { registerTenantCommands } from './commands/tenant.command.js';
import { registerUserCommands } from './commands/user.command.js';
import { registerRoleCommands } from './commands/role.command.js';
import { registerPrivilegeCommands } from './commands/privilege.command.js';
import { registerFlagCommands } from './commands/flag.command.js';
import { registerAuthCommands } from './commands/auth.command.js';
import { registerBrandingCommands } from './commands/branding.command.js';
import { registerPlanCommands } from './commands/plan.command.js';
import { registerTokenCommands } from './commands/token.command.js';
import { registerEventCommands } from './commands/event.command.js';
import { registerSetupCommands } from './commands/setup.command.js';
import { registerInfoCommands } from './commands/info.command.js';
import { registerGuideCommands } from './commands/guide.command.js';
import { registerOpsCommands } from './commands/ops.command.js';
import { registerStripeCommands } from './commands/stripe.command.js';
import { registerIntegrationCommands } from './commands/integration.command.js';
import { registerCheckCommands } from './commands/check.command.js';

/**
 * Every command group the CLI has, registered on `program`.
 *
 * Kept apart from `cli.ts` (which reads the package version through
 * `import.meta`) so tests can build the real command tree. The prompts test
 * checks every `bridge …` command the guides name against it (TBP-706).
 */
export function registerCommands(program: Command): void {
  registerAppCommands(program);
  registerTenantCommands(program);
  registerUserCommands(program);
  registerRoleCommands(program);
  registerPrivilegeCommands(program);
  registerFlagCommands(program);
  registerAuthCommands(program);
  registerBrandingCommands(program);
  registerPlanCommands(program);
  registerTokenCommands(program);
  registerEventCommands(program);
  registerSetupCommands(program);
  registerInfoCommands(program);
  registerGuideCommands(program);
  registerOpsCommands(program);
  registerStripeCommands(program);
  // After setup + event: adds `setup status` and `event auth-attempts` to those groups (TBP-541).
  registerIntegrationCommands(program);
  // TBP-705 — `bridge check gates`, the last verification step of every guide.
  registerCheckCommands(program);
}


/**
 * Commands that never act on an app through the management API, so the
 * `--app` / `currentApp` context is not resolved for them (no network call,
 * and `bridge guide` keeps working offline). Matched on the command path.
 */
const NO_APP_CONTEXT = [
  'auth login',
  'auth logout',
  'auth status',
  'auth use',
  'app list',
  'app use',
  'app create',
  'guide',
  'ops',
  'check',
];

function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Raised after the error was already printed, to stop the action running. */
export class AppContextAbort extends Error {
  constructor() {
    super('app context could not be resolved');
    this.name = 'AppContextAbort';
  }
}

/**
 * Global options and the hook that applies them before every action.
 *
 * `--profile` (TBP-628) picks WHICH stored login; `--app` (TBP-769) picks the
 * app WITHIN that login, like the MCP tools' `app` argument.
 *
 * The `--app` name collision: `bridge auth login` has its own `--app` (pin the
 * home app on the consent screen). commander lets the program-level option
 * consume the flag wherever it appears, so login would never see it. The hook
 * therefore hands the value back to any command that declares its own `--app`
 * and, for that command, does not treat it as an app selection.
 */
export function registerGlobalOptions(program: Command): void {
  program
    .option(
      '--profile <label|app-id|app-name>',
      'Use a specific stored credential for this command (env: BRIDGE_PROFILE)',
    )
    .option(
      '--app <id|name>',
      'Act on another app of your workspace login for this command (default: the app chosen with `bridge app use`, else the home app). On `auth login` it pins the home app instead',
    );

  program.hook('preAction', async (thisCommand, actionCommand) => {
    // Runs before any subcommand action, so `getManagementClient()` sees the
    // overrides wherever in the tree it is eventually called from.
    setProfileOverride(thisCommand.opts().profile as string | undefined);

    const app = thisCommand.opts().app as string | undefined;
    const ownsAppOption =
      actionCommand !== thisCommand && actionCommand.options.some((o) => o.long === '--app');
    if (ownsAppOption) {
      if (app !== undefined) actionCommand.setOptionValue('app', app);
      setAppOverride(null);
      return;
    }
    setAppOverride(app);

    const path = commandPath(actionCommand);
    if (NO_APP_CONTEXT.some((p) => path === p || path.startsWith(`${p} `))) return;

    try {
      await prepareAppContext();
    } catch (err) {
      outputError(err);
      throw new AppContextAbort();
    }
  });
}
