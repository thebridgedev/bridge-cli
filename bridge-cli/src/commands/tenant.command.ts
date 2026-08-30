import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveTenantIdByName } from '../resolve.js';

export function registerTenantCommands(program: Command): void {
  const tenant = program.command('tenant').description('Manage tenants');

  tenant.command('list')
    .description('List all tenants')
    .action(async () => {
      try { outputSuccess(await getManagementClient().tenants.list()); }
      catch (err) { outputError(err); }
    });

  tenant.command('get')
    .description('Get a tenant by --name or --id')
    .option('--name <name>', 'Tenant name to address (alternative to --id; must be unique)')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .action(async (opts) => {
      try {
        const id = await resolveTenantIdByName({ id: opts.id, key: opts.name });
        outputSuccess(await getManagementClient().tenants.get(id));
      } catch (err) { outputError(err); }
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
    .description('Update a tenant by --name or --id')
    .option('--name <name>', 'Tenant name to address when --id is absent; with --id, renames the tenant')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .option('--new-name <name>', 'Rename the tenant to this name')
    .option('--locale <locale>', 'Locale')
    .option('--logo <url>', 'Logo URL')
    .action(async (opts) => {
      try {
        // TBP-586. `--name` is overloaded for backwards compatibility: before
        // name-addressing existed, `tenant update --id X --name Y` renamed the
        // tenant, and that still works. So `--name` addresses only when `--id`
        // is absent; alongside `--id` it keeps its old rename meaning.
        // `--new-name` renames in either addressing mode.
        const addressedById = opts.id !== undefined;
        const renameTo = opts.newName !== undefined
          ? opts.newName
          : (addressedById ? opts.name : undefined);
        const id = await resolveTenantIdByName({
          id: opts.id,
          key: addressedById ? undefined : opts.name,
        });
        const data = { name: renameTo, locale: opts.locale, logo: opts.logo };
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().tenants.update(id, cleaned));
      } catch (err) { outputError(err); }
    });

  tenant.command('delete')
    .description('Delete a tenant by --name or --id')
    .option('--name <name>', 'Tenant name to address (alternative to --id; fails if not unique)')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .action(async (opts) => {
      try {
        const id = await resolveTenantIdByName({ id: opts.id, key: opts.name });
        await getManagementClient().tenants.delete(id);
        outputSuccess({ deleted: true, id });
      } catch (err) { outputError(err); }
    });
}
