import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerEventCommands(program: Command): void {
  const event = program.command('event').description('Query event log');

  event.command('list')
    .description('Query events')
    .option('--type <type>', 'Event type filter')
    .option('--tenant-id <id>', 'Filter by tenant')
    .option('--user-id <id>', 'Filter by user')
    .option('--since <duration>', 'Time filter (e.g., "24h", "7d", ISO date)')
    .option('--limit <n>', 'Max results', parseInt)
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().events.query({
          type: opts.type,
          tenantId: opts.tenantId,
          userId: opts.userId,
          since: opts.since,
          limit: opts.limit,
        }));
      } catch (err) { outputError(err); }
    });
}
