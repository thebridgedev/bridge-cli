import { Command } from 'commander';
import { getManagementClient, resolveTenantId } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveUserId } from '../resolve.js';

export function registerUserCommands(program: Command): void {
  const user = program.command('user').description('Manage tenant users');

  user.command('list')
    .description('List users in a tenant')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        outputSuccess(await getManagementClient().users.list(tenantId));
      } catch (err) { outputError(err); }
    });

  user.command('get')
    .description('Get user details by --email or --user-id')
    .option('--email <email>', 'User email to address (alternative to --user-id)')
    .option('--user-id <id>', 'User ID to address (alternative to --email)')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        const userId = await resolveUserId({ id: opts.userId, key: opts.email }, tenantId);
        outputSuccess(await getManagementClient().users.get(tenantId, userId));
      } catch (err) { outputError(err); }
    });

  user.command('invite')
    .description('Invite a user to a tenant')
    .requiredOption('--email <email>', 'User email')
    .option('--role <role>', 'Role key')
    .option('--first-name <name>', 'First name')
    .option('--last-name <name>', 'Last name')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        outputSuccess(await getManagementClient().users.invite(tenantId, {
          username: opts.email,
          role: opts.role,
          firstName: opts.firstName,
          lastName: opts.lastName,
        }));
      } catch (err) { outputError(err); }
    });

  user.command('update')
    .description('Update a user by --email or --user-id')
    .option('--email <email>', 'User email to address (alternative to --user-id)')
    .option('--user-id <id>', 'User ID to address (alternative to --email)')
    .option('--role <role>', 'Role key')
    .option('--enabled <bool>', 'Enable/disable user', (v) => v === 'true')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        const userId = await resolveUserId({ id: opts.userId, key: opts.email }, tenantId);
        const data = Object.fromEntries(
          Object.entries({ role: opts.role, enabled: opts.enabled })
            .filter(([, v]) => v !== undefined),
        );
        outputSuccess(await getManagementClient().users.update(tenantId, userId, data));
      } catch (err) { outputError(err); }
    });

  user.command('remove')
    .description('Remove a user from a tenant by --email or --user-id')
    .option('--email <email>', 'User email to address (alternative to --user-id)')
    .option('--user-id <id>', 'User ID to address (alternative to --email)')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        const userId = await resolveUserId({ id: opts.userId, key: opts.email }, tenantId);
        await getManagementClient().users.remove(tenantId, userId);
        outputSuccess({ removed: true, userId });
      } catch (err) { outputError(err); }
    });
}
