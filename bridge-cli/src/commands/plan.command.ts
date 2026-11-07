import { readFile } from 'node:fs/promises';
import { InvalidArgumentError, type Command } from 'commander';
import { plans, type Plan, type PlanFields, type Price } from '../api/billing.js';
import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';
import { attachUsage, parseCurrencyInterval, parseFeature, parseLimit, parsePrice, parseUsagePrice } from '../money.js';
import { action, collect, type Deps } from './context.js';

const PRICE_HELP = 'A price, "<amount> <CURRENCY>/<interval>" such as "19.99 EUR/month"; repeat for several';
const USAGE_HELP = 'A per-unit usage price, "<metric> <amount per unit> <CURRENCY>/<interval> [included <n>]" such as "api.calls 0.002 EUR/month included 10000"; repeat for several';

function trialDays(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 730) throw new InvalidArgumentError('A whole number of days from 1 to 730.');
  return n;
}

interface DocumentOptions {
  name?: string;
  description?: string;
  price?: string[];
  usagePrice?: string[];
  feature?: string[];
  limit?: string[];
  trialDays?: number;
  cardRequired?: boolean;
  trial?: boolean;
}

/** The plan fields the options give. Prices, features and limits are whole lists: given, they replace the plan's. */
function planFields(opts: DocumentOptions): PlanFields {
  const fields: PlanFields = {};
  if (opts.name !== undefined) fields.name = opts.name;
  if (opts.description !== undefined) fields.description = opts.description;
  if (opts.price !== undefined) fields.prices = attachUsage(opts.price.map(parsePrice), (opts.usagePrice ?? []).map(parseUsagePrice));
  else if (opts.usagePrice !== undefined) throw new CliError('invalid', 'A usage price goes on a price: give the plan\'s prices with --price too, or use `bridge plan usage-price set`.');
  if (opts.feature !== undefined) fields.features = opts.feature.map(parseFeature);
  if (opts.limit !== undefined) fields.limits = opts.limit.map(parseLimit);
  if (opts.trial === false) fields.trial = null;
  else if (opts.trialDays !== undefined) fields.trial = { days: opts.trialDays, cardRequired: opts.cardRequired ?? false };
  else if (opts.cardRequired !== undefined) throw new CliError('invalid', '--card-required goes with --trial-days.');
  return fields;
}

const withDocumentOptions = (cmd: Command) =>
  cmd
    .option('--description <text>', 'What the plan is for')
    .option('--price <price>', PRICE_HELP, collect)
    .option('--usage-price <usage>', USAGE_HELP, collect)
    .option('--feature <feature>', 'A feature the plan includes, "<key>" or "<key>=<name>"; repeat for several', collect)
    .option('--limit <limit>', 'A limit, "<metric>=<n>" or "<metric>=unlimited"; repeat for several', collect)
    .option('--trial-days <days>', 'A free trial of this many days', trialDays)
    .option('--card-required', 'The trial asks for a card up front');

/** Reads the plan, changes it, writes the changed fields back. */
async function change(c: BridgeClient, appId: string, key: string, fn: (plan: Plan) => PlanFields): Promise<Plan> {
  const plan = await plans.get(c, appId, key);
  return plans.update(c, appId, key, fn(plan));
}

const priceId = (price: Pick<Price, 'currency' | 'interval'>) => `${price.currency}/${price.interval ?? 'once'}`;

export function registerPlanCommands(program: Command, deps: Deps): void {
  const plan = program.command('plan').description('Plans: their prices, trials, usage prices, features and limits');

  plan
    .command('list')
    .description('The app\'s plans')
    .option('--archived', 'Include archived plans')
    .action(
      action(deps, async (ctx, opts: { archived?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await plans.list(c, appId, opts.archived === true));
      }),
    );

  plan
    .command('get <key>')
    .description('One plan')
    .action(
      action(deps, async (ctx, key: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await plans.get(c, appId, key));
      }),
    );

  withDocumentOptions(plan.command('create <key>').description('Create a plan').requiredOption('--name <name>', 'The plan\'s name')).action(
    action(deps, async (ctx, key: string, opts: DocumentOptions) => {
      const fields = planFields(opts);
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await plans.create(c, appId, { ...fields, key, name: opts.name as string }));
    }),
  );

  withDocumentOptions(
    plan
      .command('update <key>')
      .description('Change a plan. Lists given (--price, --feature, --limit) replace the plan\'s; the sub-commands change one entry')
      .option('--name <name>', 'The plan\'s name')
      .option('--no-trial', 'Remove the trial'),
  ).action(
    action(deps, async (ctx, key: string, opts: DocumentOptions) => {
      const fields = planFields(opts);
      if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change.');
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await plans.update(c, appId, key, fields));
    }),
  );

  plan
    .command('apply <file>')
    .description('Create or replace a plan from a JSON file: { "key", "name", "prices", "features", "limits", "trial" }')
    .action(
      action(deps, async (ctx, file: string) => {
        let document: PlanFields;
        try {
          document = JSON.parse(await readFile(file, 'utf8')) as PlanFields;
        } catch (error) {
          throw new CliError('invalid', `Could not read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof document.key !== 'string' || document.key === '') throw new CliError('invalid', `${file} names no plan "key".`);
        const { key, ...rest } = document;
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await plans.replace(c, appId, key, rest));
      }),
    );

  plan
    .command('archive <key>')
    .description('Stop offering a plan: workspaces on it keep it, nobody new can choose it')
    .option('--undo', 'Offer it again')
    .action(
      action(deps, async (ctx, key: string, opts: { undo?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await plans.archive(c, appId, key, opts.undo !== true));
      }),
    );

  plan
    .command('delete <key>')
    .description('Delete a plan no workspace is on')
    .option('--dry-run', 'Only say whether it can be deleted')
    .action(
      action(deps, async (ctx, key: string, opts: { dryRun?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        const preview = await plans.deletionPreview(c, appId, key);
        if (opts.dryRun) return ctx.io.result(preview);
        if (!preview.deletable) {
          throw new CliError('conflict', `${String(preview.holders)} workspace(s) are on ${key}, so it cannot be deleted.`, {
            hint: `Archive it instead: \`bridge plan archive ${key}\`.`,
          });
        }
        ctx.io.result(await plans.remove(c, appId, key));
      }),
    );

  const price = plan.command('price').description('One price of a plan, by currency and interval');
  price
    .command('set <plan> <price>')
    .description('Add a price, or change the one in its currency and interval ("19.99 EUR/month")')
    .action(
      action(deps, async (ctx, key: string, text: string) => {
        const given = parsePrice(text);
        const { c, appId } = await ctx.forApp();
        ctx.io.result(
          await change(c, appId, key, (p) => {
            const kept = (p.prices ?? []).find((each) => priceId(each) === priceId(given));
            const next = { ...given, ...(kept?.usage === undefined ? {} : { usage: kept.usage }) };
            return { prices: [...(p.prices ?? []).filter((each) => priceId(each) !== priceId(given)), next] };
          }),
        );
      }),
    );
  price
    .command('remove <plan> <currency-interval>')
    .description('Remove the price in a currency and interval ("EUR/month")')
    .action(
      action(deps, async (ctx, key: string, text: string) => {
        const target = priceId(parseCurrencyInterval(text));
        const { c, appId } = await ctx.forApp();
        ctx.io.result(
          await change(c, appId, key, (p) => {
            if (!(p.prices ?? []).some((each) => priceId(each) === target)) throw new CliError('not-found', `${key} has no ${text} price.`);
            return { prices: (p.prices ?? []).filter((each) => priceId(each) !== target) };
          }),
        );
      }),
    );

  const usage = plan.command('usage-price').description('Per-unit usage prices on a plan\'s prices');
  usage
    .command('set <plan> <usage>')
    .description('Add or change a usage price ("api.calls 0.002 EUR/month included 10000")')
    .action(
      action(deps, async (ctx, key: string, text: string) => {
        const given = parseUsagePrice(text);
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await change(c, appId, key, (p) => ({ prices: attachUsage(p.prices ?? [], [given]) })));
      }),
    );
  usage
    .command('remove <plan> <metric>')
    .description('Remove the usage price on a metric from every price of the plan')
    .action(
      action(deps, async (ctx, key: string, metric: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(
          await change(c, appId, key, (p) => ({
            prices: (p.prices ?? []).map(({ usage: list, ...rest }) => {
              const left = (list ?? []).filter((each) => each.metric !== metric);
              return left.length === 0 ? rest : { ...rest, usage: left };
            }),
          })),
        );
      }),
    );

  const feature = plan.command('feature').description('The features a plan includes');
  feature
    .command('add <plan> <feature>')
    .description('Include a feature ("<key>" or "<key>=<name>"), or rename one the plan has')
    .action(
      action(deps, async (ctx, key: string, text: string) => {
        const given = parseFeature(text);
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await change(c, appId, key, (p) => ({ features: [...(p.features ?? []).filter((each) => each.key !== given.key), given] })));
      }),
    );
  feature
    .command('remove <plan> <feature>')
    .description('Stop including a feature')
    .action(
      action(deps, async (ctx, key: string, featureKey: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await change(c, appId, key, (p) => ({ features: (p.features ?? []).filter((each) => each.key !== featureKey) })));
      }),
    );

  const limit = plan.command('limit').description('How much of a metric a plan allows');
  limit
    .command('set <plan> <limit>')
    .description('Set a limit ("api.calls=10000" or "seats=unlimited")')
    .action(
      action(deps, async (ctx, key: string, text: string) => {
        const given = parseLimit(text);
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await change(c, appId, key, (p) => ({ limits: [...(p.limits ?? []).filter((each) => each.metric !== given.metric), given] })));
      }),
    );
  limit
    .command('remove <plan> <metric>')
    .description('Remove a limit')
    .action(
      action(deps, async (ctx, key: string, metric: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await change(c, appId, key, (p) => ({ limits: (p.limits ?? []).filter((each) => each.metric !== metric) })));
      }),
    );
}
