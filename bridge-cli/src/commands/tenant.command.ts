import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerTenantCommands(program: Command): void {
  const tenant = program.command('tenant').description('Manage tenants');

  tenant.command('list')
    .description('List all tenants')
    .action(async () => {
      try { outputSuccess(await getManagementClient().tenants.list()); }
      catch (err) { outputError(err); }
    });

  tenant.command('get')
    .description('Get tenant by ID')
    .requiredOption('--id <id>', 'Tenant ID')
    .action(async (opts) => {
      try { outputSuccess(await getManagementClient().tenants.get(opts.id)); }
      catch (err) { outputError(err); }
    });

  tenant.command('create')
    .description('Create a new tenant')
    .requiredOption('--owner-email <email>', 'Owner email address')
    .option('--name <name>', 'Tenant name')
    .option('--plan <plan>', 'Plan key')
    .option('--locale <locale>', 'Locale (ISO 639-1)')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().tenants.create({
          owner: { email: opts.ownerEmail },
          name: opts.name,
          plan: opts.plan,
          locale: opts.locale,
        }));
      } catch (err) { outputError(err); }
    });

  tenant.command('update')
    .description('Update a tenant')
    .requiredOption('--id <id>', 'Tenant ID')
    .option('--name <name>', 'Tenant name')
    .option('--locale <locale>', 'Locale')
    .option('--logo <url>', 'Logo URL')
    .action(async (opts) => {
      try {
        const { id, ...data } = opts;
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().tenants.update(id, cleaned));
      } catch (err) { outputError(err); }
    });

  tenant.command('delete')
    .description('Delete a tenant')
    .requiredOption('--id <id>', 'Tenant ID')
    .action(async (opts) => {
      try {
        await getManagementClient().tenants.delete(opts.id);
        outputSuccess({ deleted: true, id: opts.id });
      } catch (err) { outputError(err); }
    });
}
