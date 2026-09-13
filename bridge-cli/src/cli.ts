import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
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
import { setProfileOverride } from './config.js';

// Read version from package.json so `bridge --version` never drifts from the
// published package. dist/cli.js lives at <pkg>/dist/cli.js, so `../package.json`
// resolves to the package root in both the published tarball and during dev.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const program = new Command();

program
  .name('bridge')
  .description('Bridge platform CLI — optimized for AI coding agents')
  .version(version)
  // TBP-628 — target another stored app for ONE command, without touching the
  // persisted default another process may be reading. Named `--profile` rather
  // than `--app` because `bridge auth login --app` already exists and means
  // something different (which app to authorise), and because `--profile` is
  // what aws/npm users already reach for.
  .option(
    '--profile <label|app-id|app-name>',
    'Use a specific stored credential for this command (env: BRIDGE_PROFILE)',
  );

// Runs before any subcommand action, so `getManagementClient()` sees the
// override wherever in the tree it is eventually called from.
program.hook('preAction', (thisCommand) => {
  setProfileOverride(thisCommand.opts().profile as string | undefined);
});

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
