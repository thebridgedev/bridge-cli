import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerFlagCommands(program: Command): void {
  const flag = program.command('flag').description('Manage feature flags');

  flag.command('list')
    .description('List all feature flags')
    .action(async () => {
      try { outputSuccess(await getManagementClient().flags.list()); }
      catch (err) { outputError(err); }
    });

  flag.command('create')
    .description('Create a new feature flag')
    .requiredOption('--key <key>', 'Flag key')
    .option('--description <desc>', 'Description')
    .option('--enabled', 'Enable the flag', false)
    .option('--default-value', 'Default value when no segment matches', false)
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().flags.create({
          key: opts.key,
          description: opts.description,
          enabled: opts.enabled,
          defaultValue: opts.defaultValue,
        }));
      } catch (err) { outputError(err); }
    });

  flag.command('update')
    .description('Update a feature flag')
    .requiredOption('--id <id>', 'Flag ID')
    .option('--key <key>', 'Flag key')
    .option('--description <desc>', 'Description')
    .option('--enabled <bool>', 'Enable/disable', (v) => v === 'true')
    .option('--default-value <bool>', 'Default value', (v) => v === 'true')
    .action(async (opts) => {
      try {
        const { id, ...data } = opts;
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().flags.update(id, cleaned));
      } catch (err) { outputError(err); }
    });

  flag.command('toggle')
    .description('Toggle a feature flag on/off')
    .requiredOption('--id <id>', 'Flag ID')
    .requiredOption('--enabled <bool>', 'true or false', (v) => v === 'true')
    .action(async (opts) => {
      try { outputSuccess(await getManagementClient().flags.toggle(opts.id, opts.enabled)); }
      catch (err) { outputError(err); }
    });

  flag.command('delete')
    .description('Delete a feature flag')
    .requiredOption('--id <id>', 'Flag ID')
    .action(async (opts) => {
      try {
        await getManagementClient().flags.delete(opts.id);
        outputSuccess({ deleted: true, id: opts.id });
      } catch (err) { outputError(err); }
    });
}
