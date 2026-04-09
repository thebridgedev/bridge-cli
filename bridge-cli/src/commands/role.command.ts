import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

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
    .description('Update an access role')
    .requiredOption('--id <id>', 'Role ID')
    .option('--name <name>', 'Role name')
    .option('--description <desc>', 'Description')
    .option('--privileges <list>', 'Comma-separated privilege keys', (v) => v.split(','))
    .action(async (opts) => {
      try {
        const { id, ...data } = opts;
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().roles.update(id, cleaned));
      } catch (err) { outputError(err); }
    });

  role.command('delete')
    .description('Delete an access role')
    .requiredOption('--id <id>', 'Role ID')
    .action(async (opts) => {
      try {
        await getManagementClient().roles.delete(opts.id);
        outputSuccess({ deleted: true, id: opts.id });
      } catch (err) { outputError(err); }
    });
}
