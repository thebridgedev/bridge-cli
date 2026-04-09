import { Command } from 'commander';
import { getManagementClient, resolveTenantId } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

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
    .description('Get user details')
    .requiredOption('--user-id <id>', 'User ID')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        outputSuccess(await getManagementClient().users.get(tenantId, opts.userId));
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
    .description('Update a user')
    .requiredOption('--user-id <id>', 'User ID')
    .option('--role <role>', 'Role key')
    .option('--enabled <bool>', 'Enable/disable user', (v) => v === 'true')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        const data = Object.fromEntries(
          Object.entries({ role: opts.role, enabled: opts.enabled })
            .filter(([, v]) => v !== undefined),
        );
        outputSuccess(await getManagementClient().users.update(tenantId, opts.userId, data));
      } catch (err) { outputError(err); }
    });

  user.command('remove')
    .description('Remove a user from a tenant')
    .requiredOption('--user-id <id>', 'User ID')
    .option('--tenant-id <id>', 'Tenant ID (or set BRIDGE_TENANT_ID)')
    .action(async (opts) => {
      try {
        const tenantId = resolveTenantId(opts);
        await getManagementClient().users.remove(tenantId, opts.userId);
        outputSuccess({ removed: true, userId: opts.userId });
      } catch (err) { outputError(err); }
    });
}
