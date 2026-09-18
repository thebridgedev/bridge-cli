import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

// ── Quota types + helpers ────────────────────────────────────────────────────
// Matches the backend PlanQuota shape (TBP-264). The published
// `@nebulr-group/bridge-auth-core` management plan types don't carry `quotas`
// yet, so we cast at the SDK boundary (same pattern as flag.command.ts) and read
// quotas off responses defensively. Tightening rides with TBP-236.

export type QuotaPolicy = 'hard' | 'metered';

/** TBP-275 — per-unit price for a metered quota. */
export interface QuotaPricing {
  amount: number;
  currency: string;
}

export interface Quota {
  metric: string;
  limit: number;
  policy: QuotaPolicy;
  /** Required for `metered`, forbidden for `hard`. */
  pricing?: QuotaPricing;
}

const QUOTA_POLICIES: ReadonlyArray<QuotaPolicy> = ['hard', 'metered'];

export function validateQuotaEntry(entry: {
  metric?: string;
  limit?: number;
  policy?: string;
  priceAmount?: number;
  currency?: string;
}): Quota {
  const metric = (entry.metric ?? '').trim();
  if (!metric) throw new Error('--metric is required and must be non-empty.');

  const limit = entry.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    throw new Error(`--limit must be an integer >= 0, got "${entry.limit}".`);
  }

  const policy = entry.policy as QuotaPolicy;
  if (!QUOTA_POLICIES.includes(policy)) {
    throw new Error(
      `--policy must be one of ${QUOTA_POLICIES.join(', ')}, got "${entry.policy}".`,
    );
  }

  // TBP-275 — metered quotas carry a per-unit price; hard quotas must not.
  if (policy === 'metered') {
    const amount = entry.priceAmount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `--price-amount must be a number > 0 for metered quotas, got "${entry.priceAmount}".`,
      );
    }
    const currency = (entry.currency ?? '').trim().toUpperCase();
    if (!currency) {
      throw new Error(
        'A currency is required for metered pricing. The plan has no single price currency to derive from — pass --price-currency.',
      );
    }
    return { metric, limit, policy, pricing: { amount, currency } };
  }

  if (entry.priceAmount !== undefined) {
    throw new Error('--price-amount is only valid with --policy metered.');
  }
  return { metric, limit, policy };
}

/** Upsert a quota by metric (replace if present, append otherwise). Pure. */
export function upsertQuota(quotas: Quota[], entry: Quota): Quota[] {
  return [...quotas.filter((q) => q.metric !== entry.metric), entry];
}

// ── Price helpers ─────────────────────────────────────────────────────────────

export type RecurrenceInterval = 'day' | 'week' | 'month' | 'year';
const VALID_INTERVALS: ReadonlyArray<RecurrenceInterval> = [
  'day',
  'week',
  'month',
  'year',
];

export interface PlanPriceInput {
  currency: string;
  recurrenceInterval: RecurrenceInterval;
  amount: number;
}

/**
 * Validate + normalise one price entry from CLI flags. A plan can carry several
 * prices (e.g. monthly + yearly); each is set independently and identified by
 * its currency + interval. `--interval` is always required.
 */
export function buildPriceEntry(opts: {
  amount?: number;
  currency?: string;
  interval?: string;
}): PlanPriceInput {
  const amount = opts.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`--amount must be a number >= 0, got "${opts.amount}".`);
  }
  const interval = (opts.interval ?? '') as RecurrenceInterval;
  if (!VALID_INTERVALS.includes(interval)) {
    throw new Error(
      `--interval is required and must be one of ${VALID_INTERVALS.join(', ')}, got "${opts.interval}".`,
    );
  }
  const currency = (opts.currency ?? 'USD').trim().toUpperCase();
  if (!currency) throw new Error('--currency must be non-empty.');
  return { amount, currency, recurrenceInterval: interval };
}

/**
 * TBP-617 — build the price list for `plan create`.
 *
 * The server rejects an explicitly empty `prices` array (a plan with no prices
 * can never be assigned to a workspace), so `plan create` must never send one.
 * Mirrors the MCP `create_plan` tool, which takes one flat price up front as
 * `amount` / `interval` / `currency`; further prices go through `plan price set`.
 *
 * Fails client-side when no price flags were passed, so the user gets the flags
 * that fix it instead of a `BAD_USER_INPUT` from the API.
 */
export function buildCreatePlanPrices(opts: {
  amount?: number;
  currency?: string;
  interval?: string;
}): PlanPriceInput[] {
  if (opts.amount === undefined && opts.interval === undefined) {
    throw new Error(
      'A plan needs at least one price. Pass --amount and --interval ' +
        `(one of ${VALID_INTERVALS.join(', ')}), e.g. --amount 29 --interval month. ` +
        'Use --amount 0 for a free or contact-sales tier; --currency defaults to USD.',
    );
  }
  return [buildPriceEntry(opts)];
}

/**
 * TBP-617 — remove one price by currency + interval.
 *
 * Throws when the price is absent, and when it is the plan's LAST price: the
 * server rejects an empty price list with a 400 the user cannot act on, so say
 * why here. Mirrors the MCP `remove_plan_price` `LAST_PRICE` guard. Pure.
 */
export function removePrice(
  prices: PlanPriceInput[],
  entry: { currency: string; interval: RecurrenceInterval },
  planKey: string,
): PlanPriceInput[] {
  const currency = entry.currency.trim().toUpperCase();
  const next = prices.filter(
    (p) => !(p.currency === currency && p.recurrenceInterval === entry.interval),
  );
  if (next.length === prices.length) {
    throw new Error(`No ${currency} ${entry.interval} price on plan "${planKey}".`);
  }
  if (next.length === 0) {
    throw new Error(
      `Cannot remove the only price on plan "${planKey}": a plan needs at least one price. ` +
        `Add the replacement first with \`bridge plan price set ${planKey} --amount <n> --interval <interval>\`, ` +
        'or set this price to --amount 0 for a free tier.',
    );
  }
  return next;
}

/** Upsert a price by (currency + interval): replace if present, append otherwise. Pure. */
export function upsertPrice(
  prices: PlanPriceInput[],
  entry: PlanPriceInput,
): PlanPriceInput[] {
  return [
    ...prices.filter(
      (p) =>
        !(
          p.currency === entry.currency &&
          p.recurrenceInterval === entry.recurrenceInterval
        ),
    ),
    entry,
  ];
}

/** Fetch a plan + its quotas/prices (read defensively — list() may omit them). */
async function getPlan(
  key: string,
): Promise<{ plan: Record<string, unknown>; quotas: Quota[]; prices: PlanPriceInput[] }> {
  const plans = (await getManagementClient().plans.list()) as unknown as Record<string, unknown>[];
  const plan = plans.find((p) => p.key === key);
  if (!plan) throw new Error(`Plan not found: ${key}`);
  const quotas = ((plan as { quotas?: Quota[] }).quotas ?? []) as Quota[];
  const prices = ((plan as { prices?: PlanPriceInput[] }).prices ?? []) as PlanPriceInput[];
  return { plan, quotas, prices };
}

export function registerPlanCommands(program: Command): void {
  const plan = program.command('plan').description('Manage subscription plans');

  plan.command('list')
    .description('List all subscription plans')
    .action(async () => {
      try { outputSuccess(await getManagementClient().plans.list()); }
      catch (err) { outputError(err); }
    });

  plan.command('get')
    .description('Get a plan by key (includes usage quotas)')
    .argument('<key>', 'Plan key')
    .action(async (key: string) => {
      try {
        const { plan: found, quotas } = await getPlan(key);
        outputSuccess({ ...found, quotas });
      } catch (err) { outputError(err); }
    });

  plan.command('create')
    .description('Create a new plan with its first price (add more with `plan price set`)')
    .requiredOption('--key <key>', 'Plan key')
    .requiredOption('--name <name>', 'Plan name')
    .option('--amount <amount>', 'First price amount (>= 0). Use 0 for a free or contact-sales tier', parseFloat)
    .option('--interval <interval>', `Billing interval for the first price: ${VALID_INTERVALS.join(' | ')}`)
    .option('--currency <currency>', 'Currency for the first price (default USD)')
    .option('--description <desc>', 'Description')
    .option('--trial', 'Include trial period', false)
    .option('--trial-days <days>', 'Trial period in days', parseInt)
    .action(async (opts) => {
      try {
        // TBP-617 — the server rejects an explicitly empty price list, so build
        // (and validate) the first price here rather than sending `prices: []`.
        const prices = buildCreatePlanPrices({
          amount: opts.amount,
          interval: opts.interval,
          currency: opts.currency,
        });
        outputSuccess(await getManagementClient().plans.create({
          key: opts.key,
          name: opts.name,
          description: opts.description,
          trial: opts.trial,
          trialDays: opts.trialDays,
          prices,
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

  registerPriceCommands(plan);
  registerQuotaCommands(plan);
}

// ── plan price (recurring prices) ────────────────────────────────────────────

function registerPriceCommands(plan: Command): void {
  const price = plan
    .command('price')
    .description("Manage a plan's recurring prices (one per currency + interval)");

  price.command('set')
    .description('Add or update a price on a plan (idempotent by currency + interval)')
    .argument('<key>', 'Plan key')
    .requiredOption('--amount <amount>', 'Price amount (>= 0)', parseFloat)
    .requiredOption('--interval <interval>', `Billing interval: ${VALID_INTERVALS.join(' | ')}`)
    .option('--currency <currency>', 'Currency (default USD)', 'USD')
    .action(async (key: string, opts) => {
      try {
        const entry = buildPriceEntry({
          amount: opts.amount,
          interval: opts.interval,
          currency: opts.currency,
        });
        const { prices } = await getPlan(key);
        const next = upsertPrice(prices, entry);
        outputSuccess(await getManagementClient().plans.update(key, { prices: next }));
      } catch (err) { outputError(err); }
    });

  price.command('rm')
    .description('Remove a price from a plan by interval (+ currency)')
    .argument('<key>', 'Plan key')
    .requiredOption('--interval <interval>', `Billing interval: ${VALID_INTERVALS.join(' | ')}`)
    .option('--currency <currency>', 'Currency (default USD)', 'USD')
    .action(async (key: string, opts) => {
      try {
        const { prices } = await getPlan(key);
        // TBP-617 — removing the last price empties the list, which the server
        // rejects with a 400; removePrice says why before we get there.
        const next = removePrice(
          prices,
          {
            currency: String(opts.currency ?? 'USD'),
            interval: opts.interval as RecurrenceInterval,
          },
          key,
        );
        outputSuccess(await getManagementClient().plans.update(key, { prices: next }));
      } catch (err) { outputError(err); }
    });
}

// ── plan quota (usage caps) ──────────────────────────────────────────────────

function registerQuotaCommands(plan: Command): void {
  const quota = plan
    .command('quota')
    .description('Manage a plan\'s usage quotas (hard | metered caps)');

  quota.command('list')
    .description('List the usage quotas on a plan')
    .argument('<key>', 'Plan key')
    .action(async (key: string) => {
      try {
        const { quotas } = await getPlan(key);
        outputSuccess(quotas);
      } catch (err) { outputError(err); }
    });

  quota.command('set')
    .description('Add or update a usage quota on a plan')
    .argument('<key>', 'Plan key')
    .requiredOption('--metric <metric>', 'Metric key (e.g. num.clicks)')
    .requiredOption('--limit <n>', 'Limit (integer >= 0). 0 = pure per-unit metered (billed from unit 1)', parseInt)
    .requiredOption('--policy <policy>', `Cap policy: ${QUOTA_POLICIES.join(' | ')}`)
    .option('--price-amount <n>', 'Per-unit price for metered quotas (required with --policy metered)', parseFloat)
    .option('--price-currency <currency>', 'Currency for the metered price (defaults to the plan\'s price currency when unambiguous)')
    .action(async (key: string, opts) => {
      try {
        const { quotas, prices } = await getPlan(key);
        // Derive the metered currency from the plan's prices when not given and
        // unambiguous; the backend enforces currency == a plan price currency.
        const planCurrencies = [
          ...new Set(prices.map((p) => p.currency?.toUpperCase()).filter(Boolean)),
        ];
        const currency =
          (opts.priceCurrency as string | undefined)?.toUpperCase() ??
          (planCurrencies.length === 1 ? planCurrencies[0] : undefined);
        const entry = validateQuotaEntry({
          metric: opts.metric,
          limit: opts.limit,
          policy: opts.policy,
          priceAmount: opts.priceAmount,
          currency,
        });
        const next = upsertQuota(quotas, entry);
        outputSuccess(await getManagementClient().plans.update(key, { quotas: next } as never));
      } catch (err) { outputError(err); }
    });

  quota.command('rm')
    .description('Remove a usage quota from a plan')
    .argument('<key>', 'Plan key')
    .requiredOption('--metric <metric>', 'Metric key to remove')
    .action(async (key: string, opts) => {
      try {
        const { quotas } = await getPlan(key);
        const next = quotas.filter((q) => q.metric !== opts.metric);
        if (next.length === quotas.length) {
          throw new Error(`No quota for metric "${opts.metric}" on plan "${key}".`);
        }
        outputSuccess(await getManagementClient().plans.update(key, { quotas: next } as never));
      } catch (err) { outputError(err); }
    });
}
