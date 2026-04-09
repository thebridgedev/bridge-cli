import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerPlanCommands(program: Command): void {
  const plan = program.command('plan').description('Manage subscription plans');

  plan.command('list')
    .description('List all subscription plans')
    .action(async () => {
      try { outputSuccess(await getManagementClient().plans.list()); }
      catch (err) { outputError(err); }
    });

  plan.command('create')
    .description('Create a new plan')
    .requiredOption('--key <key>', 'Plan key')
    .requiredOption('--name <name>', 'Plan name')
    .option('--description <desc>', 'Description')
    .option('--trial', 'Include trial period', false)
    .option('--trial-days <days>', 'Trial period in days', parseInt)
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().plans.create({
          key: opts.key,
          name: opts.name,
          description: opts.description,
          trial: opts.trial,
          trialDays: opts.trialDays,
        }));
      } catch (err) { outputError(err); }
    });

  plan.command('update')
    .description('Update a plan')
    .requiredOption('--key <key>', 'Plan key')
    .option('--name <name>', 'Plan name')
    .option('--description <desc>', 'Description')
    .action(async (opts) => {
      try {
        const { key, ...data } = opts;
        const cleaned = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        outputSuccess(await getManagementClient().plans.update(key, cleaned));
      } catch (err) { outputError(err); }
    });
}
