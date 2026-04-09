import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

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
    .description('Revoke an API token')
    .requiredOption('--id <id>', 'Token ID')
    .action(async (opts) => {
      try {
        await getManagementClient().tokens.revoke(opts.id);
        outputSuccess({ revoked: true, id: opts.id });
      } catch (err) { outputError(err); }
    });
}
