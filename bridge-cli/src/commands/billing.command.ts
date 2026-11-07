import type { Command } from 'commander';
import { billingSettings, connection, metrics, products, taxes, type BillingSettings, type ProductFields } from '../api/billing.js';
import { withAppKey } from '../api/keys.js';
import { CliError } from '../core/errors.js';
import { parseFeature, parsePrice } from '../money.js';
import { action, collect, type Context, type Deps } from './context.js';

function parseAdds(text: string): { metric: string; add: number } {
  const [metric, value] = text.split('=') as [string, string?];
  const add = Number(value);
  if (!metric || !Number.isSafeInteger(add) || add < 1) throw new CliError('invalid', `An add-on's limit is "<metric>=<n>", how much one unit adds: ${text}`);
  return { metric, add };
}

interface ProductOptions {
  name?: string;
  description?: string;
  kind?: string;
  price?: string[];
  feature?: string[];
  adds?: string[];
}

function productFields(opts: ProductOptions): ProductFields {
  const fields: ProductFields = {};
  if (opts.name !== undefined) fields.name = opts.name;
  if (opts.description !== undefined) fields.description = opts.description;
  if (opts.price !== undefined) fields.prices = opts.price.map(parsePrice);
  if (opts.feature !== undefined) fields.features = opts.feature.map(parseFeature);
  if (opts.adds !== undefined) fields.limits = opts.adds.map(parseAdds);
  return fields;
}

const withProductOptions = (cmd: Command) =>
  cmd
    .option('--description <text>', 'What it is')
    .option('--price <price>', 'A price, "<amount> <CURRENCY>/<interval>", or "<amount> <CURRENCY>" for a one-time product; repeat for several', collect)
    .option('--feature <feature>', 'A feature it gives, "<key>" or "<key>=<name>"; repeat for several', collect)
    .option('--adds <limit>', 'How much one unit adds to a limit, "<metric>=<n>"; repeat for several', collect);

/** Reads a secret from stdin when asked to, else asks for it without echo. Never from an argument. */
async function secret(ctx: Context, fromStdin: boolean | undefined, prompt: string): Promise<string> {
  if (fromStdin) return (await ctx.io.readStdin()).trim();
  if (!ctx.io.interactive) throw new CliError('invalid', 'No terminal to ask for the key in.', { hint: 'Pipe it in with --secret-key-stdin.' });
  return (await ctx.io.askHidden(prompt)).trim();
}

export function registerBillingCommands(program: Command, deps: Deps): void {
  // ── Products ───────────────────────────────────────────────────────────────
  const product = program.command('product').description('Add-ons and one-time products, sold next to the plans');
  product
    .command('list')
    .option('--archived', 'Include archived products')
    .action(
      action(deps, async (ctx, opts: { archived?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await products.list(c, appId, opts.archived === true));
      }),
    );
  product.command('get <key>').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await products.get(c, appId, key));
    }),
  );
  withProductOptions(
    product
      .command('create <key>')
      .description('Create a product')
      .requiredOption('--name <name>', 'Its name')
      .requiredOption('--kind <kind>', 'addon (added to a subscription) or one_time (bought alone)'),
  ).action(
    action(deps, async (ctx, key: string, opts: ProductOptions) => {
      if (opts.kind !== 'addon' && opts.kind !== 'one_time') throw new CliError('invalid', '--kind is addon or one_time.');
      const fields = productFields(opts);
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await products.create(c, appId, { ...fields, key, name: opts.name as string, kind: opts.kind }));
    }),
  );
  withProductOptions(product.command('update <key>').description('Change a product; lists given replace its lists').option('--name <name>', 'Its name')).action(
    action(deps, async (ctx, key: string, opts: ProductOptions) => {
      const fields = productFields(opts);
      if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change.');
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await products.update(c, appId, key, fields));
    }),
  );
  product
    .command('archive <key>')
    .option('--undo', 'Offer it again')
    .action(
      action(deps, async (ctx, key: string, opts: { undo?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await products.archive(c, appId, key, opts.undo !== true));
      }),
    );
  product.command('delete <key>').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await products.remove(c, appId, key));
    }),
  );

  // ── Metrics ────────────────────────────────────────────────────────────────
  const metric = program.command('metric').description('What the app counts, for usage prices and limits (api.calls and seats are built in)');
  metric.command('list').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await metrics.list(c, appId));
    }),
  );
  metric
    .command('set <key>')
    .description('Add or change a metric, such as "exports" or "storage.gb"')
    .requiredOption('--kind <kind>', 'counter (adds up each period, such as exports) or gauge (a level, such as storage)')
    .option('--name <name>', 'Its name, as people read it')
    .action(
      action(deps, async (ctx, key: string, opts: { kind: string; name?: string }) => {
        if (opts.kind !== 'counter' && opts.kind !== 'gauge') throw new CliError('invalid', '--kind is counter or gauge.');
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await metrics.set(c, appId, key, { kind: opts.kind, ...(opts.name === undefined ? {} : { name: opts.name }) }));
      }),
    );
  metric.command('remove <key>').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await metrics.remove(c, appId, key));
    }),
  );

  // ── Taxes and settings ─────────────────────────────────────────────────────
  const tax = program.command('tax').description('Tax rates per country');
  tax.command('list').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await taxes.list(c, appId));
    }),
  );
  tax
    .command('set <country>')
    .description('Set the tax rate for a country by its two-letter code ("SE")')
    .requiredOption('--name <name>', 'The tax\'s name, such as "VAT"')
    .requiredOption('--rate <percent>', 'The rate in percent, such as 25 or 7.5')
    .action(
      action(deps, async (ctx, country: string, opts: { name: string; rate: string }) => {
        const percent = Number(opts.rate);
        const basisPoints = Math.round(percent * 100);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100 || Math.abs(basisPoints - percent * 100) > 1e-6) {
          throw new CliError('invalid', '--rate is a percent from 0 to 100, with at most two decimals.');
        }
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await taxes.set(c, appId, country, { name: opts.name, basisPoints }));
      }),
    );
  tax.command('remove <country>').action(
    action(deps, async (ctx, country: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await taxes.remove(c, appId, country));
    }),
  );

  const billing = program.command('billing').description('The app\'s billing settings');
  billing
    .command('settings')
    .description('Show the billing settings, or change them with the options')
    .option('--currency <code>', 'The currency payers see first, such as EUR ("none" clears it)')
    .option('--return-url <url>', 'Where payers return after checkout ("none" clears it)')
    .option('--auto-redirect', 'Send payers to checkout without asking')
    .option('--no-auto-redirect', 'Ask payers before sending them to checkout')
    .action(
      action(deps, async (ctx, opts: { currency?: string; returnUrl?: string; autoRedirect?: boolean }) => {
        const fields: BillingSettings = {};
        if (opts.currency !== undefined) fields.currency = opts.currency === 'none' ? null : opts.currency.toUpperCase();
        if (opts.returnUrl !== undefined) fields.returnUrl = opts.returnUrl === 'none' ? null : opts.returnUrl;
        if (opts.autoRedirect !== undefined) fields.paymentsAutoRedirect = opts.autoRedirect;
        const { c, appId } = await ctx.forApp();
        ctx.io.result(Object.keys(fields).length === 0 ? await billingSettings.get(c, appId) : await billingSettings.update(c, appId, fields));
      }),
    );

  // ── Stripe ─────────────────────────────────────────────────────────────────
  const stripe = program.command('stripe').description('Take payments through Stripe');
  stripe
    .command('status')
    .description('Whether the app is connected to Stripe')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await connection.get(c, appId));
      }),
    );
  stripe
    .command('connect')
    .description('Connect Stripe in test mode with your secret key (sk_test_…). Asked for without echo, or read from stdin')
    .option('--secret-key-stdin', 'Read the secret key from stdin')
    .option('--publishable-key <key>', 'Your publishable key (pk_test_…)')
    .option('--live', 'Allow a live key (sk_live_…)')
    .action(
      action(deps, async (ctx, opts: { secretKeyStdin?: boolean; publishableKey?: string; live?: boolean }) => {
        const secretKey = await secret(ctx, opts.secretKeyStdin, 'Stripe secret key (sk_test_…): ');
        if (!/^(sk|rk)_(test|live)_\w+$/.test(secretKey)) throw new CliError('invalid', 'That is not a Stripe secret key (sk_test_… or rk_test_…).');
        if (/_live_/.test(secretKey) && !opts.live) {
          throw new CliError('invalid', 'That is a live key. Connect in test mode with a test key, or pass --live to take real payments.');
        }
        if (opts.publishableKey !== undefined && !/^pk_(test|live)_\w+$/.test(opts.publishableKey)) {
          throw new CliError('invalid', 'That is not a Stripe publishable key (pk_test_…).');
        }
        const { c, appId } = await ctx.forApp();
        const connected = await withAppKey(c, appId, [], ctx.env, (key) =>
          connection.pasteKey(c, key, { secretKey, ...(opts.publishableKey === undefined ? {} : { publishableKey: opts.publishableKey }) }),
          (message) => ctx.io.info(message),
        );
        ctx.io.result(connected);
      }),
    );
  stripe
    .command('disconnect')
    .description('Stop taking payments through Stripe. Needs a recent sign-in')
    .requiredOption('--yes', 'Confirm')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await connection.remove(c, appId));
      }),
    );
}
