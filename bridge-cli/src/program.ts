import type { Command } from 'commander';
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
