import { Command } from 'commander';
import { registerAppCommands } from './commands/app.command.js';
import { registerTenantCommands } from './commands/tenant.command.js';
import { registerUserCommands } from './commands/user.command.js';
import { registerRoleCommands } from './commands/role.command.js';
import { registerFlagCommands } from './commands/flag.command.js';
import { registerAuthCommands } from './commands/auth.command.js';
import { registerBrandingCommands } from './commands/branding.command.js';
import { registerPlanCommands } from './commands/plan.command.js';
import { registerTokenCommands } from './commands/token.command.js';
import { registerEventCommands } from './commands/event.command.js';
import { registerSetupCommands } from './commands/setup.command.js';
import { registerInfoCommands } from './commands/info.command.js';
import { registerGuideCommands } from './commands/guide.command.js';

export const program = new Command();

program
  .name('bridge')
  .description('Bridge platform CLI — optimized for AI coding agents')
  .version('0.1.0-alpha.1');

registerAppCommands(program);
registerTenantCommands(program);
registerUserCommands(program);
registerRoleCommands(program);
registerFlagCommands(program);
registerAuthCommands(program);
registerBrandingCommands(program);
registerPlanCommands(program);
registerTokenCommands(program);
registerEventCommands(program);
registerSetupCommands(program);
registerInfoCommands(program);
registerGuideCommands(program);
