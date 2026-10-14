import { Command } from 'commander';
import { getManagementClient, getManagementHttp } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveTenantIdByName } from '../resolve.js';
import { shapeTenant } from '../shape.js';
import { dryRunPreview } from '../preview.js';

export function registerTenantCommands(program: Command): void {
  const tenant = program.command('tenant').description('Manage tenants');

  tenant.command('list')
    .description('List all tenants')
    .action(async () => {
      try { outputSuccess((await getManagementClient().tenants.list()).map(shapeTenant)); }
      catch (err) { outputError(err); }
    });

  tenant.command('get')
    .description('Get a tenant by --name or --id')
    .option('--name <name>', 'Tenant name to address (alternative to --id; must be unique)')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .action(async (opts) => {
      try {
        const id = await resolveTenantIdByName({ id: opts.id, key: opts.name });
        outputSuccess(shapeTenant(await getManagementClient().tenants.get(id)));
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
        outputSuccess(shapeTenant(await getManagementClient().tenants.create({
          owner: { email: opts.ownerEmail },
          name: opts.name,
          plan: opts.plan,
          locale: opts.locale,
        })));
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
        outputSuccess(shapeTenant(await getManagementClient().tenants.update(id, cleaned)));
      } catch (err) { outputError(err); }
    });

  // TBP-806 — the dashboard's plan picker on a workspace, from the terminal:
  // the same route, which also moves a paid Stripe subscription. What clears a
  // plan before `plan delete`.
  tenant.command('set-plan')
    .description('Move a tenant to another plan by --name or --id (a paid Stripe subscription moves with it)')
    .option('--name <name>', 'Tenant name to address (alternative to --id; fails if not unique)')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .requiredOption('--plan <key>', 'Plan key to move the tenant to')
    .option('--interval <interval>', "Which of the plan's prices: day | week | month | year (default: its first price)")
    .option('--currency <code>', "Which of the plan's prices: its currency, e.g. usd")
    .action(async (opts) => {
      try {
        const id = await resolveTenantIdByName({ id: opts.id, key: opts.name });
        const plans = (await getManagementClient().plans.list()) as unknown as Array<{
          key: string;
          prices?: Array<{ currency: string; recurrenceInterval: string; amount: number }>;
        }>;
        const plan = plans.find((p) => p.key === opts.plan);
        if (!plan) {
          throw new Error(`Plan not found: ${opts.plan}. Existing plan keys: ${plans.map((p) => p.key).join(', ') || '(none)'}.`);
        }
        const currency = (opts.currency as string | undefined)?.toUpperCase();
        const prices = plan.prices ?? [];
        const price = prices.find(
          (p) => (!currency || p.currency.toUpperCase() === currency) && (!opts.interval || p.recurrenceInterval === opts.interval),
        );
        if (!price) {
          throw new Error(
            `Plan ${opts.plan} has no matching price. Its prices: ` +
              (prices.map((p) => `${p.currency} ${p.recurrenceInterval} ${p.amount}`).join(', ') || '(none)') + '.',
          );
        }
        await getManagementHttp().post(`/v1/account/tenant/${encodeURIComponent(id)}/planDetails`, {
          planKey: opts.plan,
          priceOffer: { currency: price.currency, recurrenceInterval: price.recurrenceInterval },
        });
        outputSuccess({ id, plan: opts.plan, price: { currency: price.currency, recurrenceInterval: price.recurrenceInterval, amount: price.amount } });
      } catch (err) { outputError(err); }
    });

  tenant.command('delete')
    .description('Delete a tenant by --name or --id')
    .option('--name <name>', 'Tenant name to address (alternative to --id; fails if not unique)')
    .option('--id <id>', 'Tenant ID to address (alternative to --name)')
    .option('--dry-run', 'Show the members, login accounts and side effects the delete would have, and delete nothing')
    .action(async (opts) => {
      try {
        const id = await resolveTenantIdByName({ id: opts.id, key: opts.name });
        if (opts.dryRun) {
          outputSuccess(await dryRunPreview(`/v1/account/tenant/${encodeURIComponent(id)}`));
          return;
        }
        await getManagementClient().tenants.delete(id);
        outputSuccess({ deleted: true, id });
      } catch (err) { outputError(err); }
    });
}
