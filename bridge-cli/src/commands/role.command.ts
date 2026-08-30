import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveRoleId } from '../resolve.js';

export function registerRoleCommands(program: Command): void {
  const role = program.command('role').description('Manage access roles');

  role.command('list')
    .description('List all access roles')
    .action(async () => {
      try { outputSuccess(await getManagementClient().roles.list()); }
      catch (err) { outputError(err); }
    });

  role.command('create')
    .description('Create a new access role')
    .requiredOption('--name <name>', 'Role name')
    .requiredOption('--key <key>', 'Role key')
    .option('--description <desc>', 'Description')
    .option('--privileges <list>', 'Comma-separated privilege keys', (v) => v.split(','))
    .option('--is-default', 'Set as default role', false)
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().roles.create({
          name: opts.name,
          key: opts.key,
          description: opts.description,
          privileges: opts.privileges ?? [],
          isDefault: opts.isDefault,
        }));
      } catch (err) { outputError(err); }
    });

  role.command('update')
    .description('Update an access role by --key or --id')
    .option('--key <key>', 'Role key to address, e.g. ADMIN (alternative to --id)')
    .option('--id <id>', 'Role ID to address (alternative to --key)')
    .option('--name <name>', 'Role name')
    .option('--description <desc>', 'Description')
    .option('--privileges <list>', 'Comma-separated privilege keys', (v) => v.split(','))
    .action(async (opts) => {
      try {
        // TBP-586: `--key`/`--id` are addressing only — strip both out of the
        // write payload so addressing by key can never be read as a rename.
        const { id: _id, key: _key, ...data } = opts;
        const roleId = await resolveRoleId({ id: opts.id, key: opts.key });
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().roles.update(roleId, cleaned));
      } catch (err) { outputError(err); }
    });

  role.command('delete')
    .description('Delete an access role by --key or --id')
    .option('--key <key>', 'Role key to address, e.g. ADMIN (alternative to --id)')
    .option('--id <id>', 'Role ID to address (alternative to --key)')
    .action(async (opts) => {
      try {
        const id = await resolveRoleId({ id: opts.id, key: opts.key });
        await getManagementClient().roles.delete(id);
        outputSuccess({ deleted: true, id });
      } catch (err) { outputError(err); }
    });
}
