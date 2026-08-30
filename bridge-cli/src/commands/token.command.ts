import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveTokenIdByName } from '../resolve.js';

export function registerTokenCommands(program: Command): void {
  const token = program.command('token').description('Manage API tokens');

  token.command('list')
    .description('List all API tokens')
    .action(async () => {
      try { outputSuccess(await getManagementClient().tokens.list()); }
      catch (err) { outputError(err); }
    });

  token.command('create')
    .description('Create a new API token')
    .requiredOption('--name <name>', 'Token name')
    .option('--privileges <list>', 'Comma-separated privilege keys', (v) => v.split(','))
    .option('--expire-at <date>', 'Expiration date (ISO format)')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().tokens.create({
          name: opts.name,
          privileges: opts.privileges ?? [],
          expireAt: opts.expireAt,
        }));
      } catch (err) { outputError(err); }
    });

  token.command('revoke')
    .description('Revoke an API token by --name or --id')
    .option('--name <name>', 'Token name to address (alternative to --id; fails if not unique)')
    .option('--id <id>', 'Token ID to address (alternative to --name)')
    .action(async (opts) => {
      try {
        const id = await resolveTokenIdByName({ id: opts.id, key: opts.name });
        await getManagementClient().tokens.revoke(id);
        outputSuccess({ revoked: true, id });
      } catch (err) { outputError(err); }
    });
}
