import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { shapePlan } from '../shape.js';
import { DecisionNeededError, decisionField, type DecisionField } from '../product-decisions.js';

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

/**
 * TBP-699 — how a quota's metric is counted. `counter`: reported events summed
 * per billing period, reset each period. `gauge`: an absolute value the app
 * sets, never reset. If deleting it frees room, it's a gauge and your app
 * counts it; if it happened, it's a counter and Bridge counts it.
 */
export type QuotaKind = 'counter' | 'gauge';

export interface Quota {
  metric: string;
  limit: number;
  policy: QuotaPolicy;
  /** TBP-699 — absent on quotas created before kinds existed: a counter. */
  kind?: QuotaKind;
  /** Required for `metered`, forbidden for `hard`. */
  pricing?: QuotaPricing;
}

const QUOTA_POLICIES: ReadonlyArray<QuotaPolicy> = ['hard', 'metered'];
const QUOTA_KINDS: ReadonlyArray<QuotaKind> = ['counter', 'gauge'];

/** TBP-699 — the built-in seats gauge: Bridge counts it from workspace membership. */
export const SEATS_METRIC = 'users';

/** The kind a quota resolves to — same rule as the server. */
export function quotaKindOf(quota: { metric: string; kind?: string }): QuotaKind {
  if (quota.metric === SEATS_METRIC) return 'gauge';
  return quota.kind === 'gauge' ? 'gauge' : 'counter';
}

export interface MetricSummary {
  metric: string;
  /** `mixed` when the plans disagree on the metric's kind. */
  kind: QuotaKind | 'mixed';
  /** TBP-709 — true for the seats gauge Bridge counts itself. */
  builtIn?: boolean;
  plans: Array<{ planKey: string; kind: QuotaKind; limit: number; policy: QuotaPolicy }>;
}

/**
 * TBP-699 — every metric configured on any plan, once each, with its kind and
 * the plans that limit it. Pure; mirrors the MCP `list_plan_quotas` tool.
 */
export function listMetrics(
  plans: Array<{ key?: unknown; quotas?: Quota[] }>,
): MetricSummary[] {
  const byMetric = new Map<string, MetricSummary>();
  for (const plan of plans) {
    for (const q of plan.quotas ?? []) {
      const kind = quotaKindOf(q);
      const entry = byMetric.get(q.metric) ?? { metric: q.metric, kind, plans: [] };
      if (entry.kind !== kind) entry.kind = 'mixed';
      entry.plans.push({ planKey: String(plan.key), kind, limit: q.limit, policy: q.policy });
      byMetric.set(q.metric, entry);
    }
  }
  // TBP-709 — the built-in seats gauge is a metric every app may use, even
  // before any plan limits it, so it is always listed (as MCP list_plan_quotas).
  const seats = byMetric.get(SEATS_METRIC);
  if (seats) seats.builtIn = true;
  else byMetric.set(SEATS_METRIC, { metric: SEATS_METRIC, kind: 'gauge', builtIn: true, plans: [] });
  return [...byMetric.values()].sort((a, b) => a.metric.localeCompare(b.metric));
}

export function validateQuotaEntry(entry: {
  metric?: string;
  limit?: number;
  policy?: string;
  kind?: string;
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

  // TBP-699 — counter vs gauge. Only sent when given (or implied by `users`),
  // so an omitted kind leaves the server's default/stored kind in charge.
  let kind: QuotaKind | undefined;
  if (entry.kind !== undefined) {
    if (!QUOTA_KINDS.includes(entry.kind as QuotaKind)) {
      throw new Error(`--kind must be one of ${QUOTA_KINDS.join(', ')}, got "${entry.kind}".`);
    }
    kind = entry.kind as QuotaKind;
  }
  if (metric === SEATS_METRIC) {
    if (kind === 'counter') {
      throw new Error(
        `"${SEATS_METRIC}" is the built-in seats gauge (Bridge counts the workspace's enabled members); it cannot be a counter.`,
      );
    }
    kind = 'gauge';
  }
  if (policy === 'metered' && kind === 'gauge') {
    throw new Error(
      `"${metric}" is a gauge and a gauge cannot be metered: metered billing charges for usage that happened during a period, which only a counter records. Use --policy hard, or --kind counter.`,
    );
  }
  const withKind = kind ? { kind } : {};

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
    return { metric, limit, policy, ...withKind, pricing: { amount, currency } };
  }

  if (entry.priceAmount !== undefined) {
    throw new Error('--price-amount is only valid with --policy metered.');
  }
  return { metric, limit, policy, ...withKind };
}

/** Upsert a quota by metric (replace if present, append otherwise). Pure. */
export function upsertQuota(quotas: Quota[], entry: Quota): Quota[] {
  return [...quotas.filter((q) => q.metric !== entry.metric), entry];
}

// ── Plan features (TBP-755) ─────────────────────────────────────────────────
// A plan lists the on/off features it sells. Each key reaches the SDK as
// `bridge:billing.entitlement.<key>`: true on workspaces whose plan lists it,
// false when another plan of the app does. A flag rule
// `bridge:billing.entitlement.<key> eq true` gates the feature, so changing
// what a plan sells is one edit here and no flag rule has to follow.

export interface PlanFeature {
  key: string;
  name: string;
}

/** An Error carrying a machine-readable `code` that outputError reports. */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Same pattern the server enforces. */
export const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Validate one feature key client-side, with a message that says how to fix it. */
export function validateFeatureKey(key: string): string {
  const k = (key ?? '').trim();
  if (!FEATURE_KEY_PATTERN.test(k)) {
    throw codedError(
      'INVALID_FEATURE',
      `Feature key "${key}" is not valid: use lower-case letters, digits and underscores, starting with a letter (e.g. "analytics", "priority_support").`,
    );
  }
  return k;
}

/** One feature entry; the display name defaults to the key. */
export function buildFeature(key: string, name?: string): PlanFeature {
  const k = validateFeatureKey(key);
  const n = (name ?? '').trim();
  return { key: k, name: n || k };
}

/**
 * Parse `--features`: comma-separated `key` or `key:Display Name` entries,
 * e.g. `analytics,sso:Single sign-on`. A repeated key keeps the last entry.
 */
export function parseFeaturesOption(raw: string): PlanFeature[] {
  let features: PlanFeature[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const i = entry.indexOf(':');
    const feature = i === -1 ? buildFeature(entry) : buildFeature(entry.slice(0, i), entry.slice(i + 1));
    features = upsertFeature(features, feature);
  }
  return features;
}

/** Upsert a feature by key (replace in place if present, append otherwise). Pure. */
export function upsertFeature(features: PlanFeature[], entry: PlanFeature): PlanFeature[] {
  const i = features.findIndex((f) => f.key === entry.key);
  if (i === -1) return [...features, entry];
  const next = [...features];
  next[i] = entry;
  return next;
}

/** Remove a feature by key; throws naming the existing keys when absent. Pure. */
export function removeFeature(features: PlanFeature[], key: string, planKey: string): PlanFeature[] {
  const next = features.filter((f) => f.key !== key);
  if (next.length === features.length) {
    throw codedError(
      'FEATURE_NOT_FOUND',
      `No feature "${key}" on plan "${planKey}". Existing features: ${
        features.length ? features.map((f) => f.key).join(', ') : '(none)'
      }.`,
    );
  }
  return next;
}

/** A plan's features, read defensively (older servers omit the field). */
export function featuresOf(plan: unknown): PlanFeature[] {
  const raw = (plan as { features?: unknown } | null)?.features;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is { key: string; name?: string } => !!f && typeof (f as { key?: unknown }).key === 'string')
    .map((f) => ({ key: f.key, name: typeof f.name === 'string' && f.name ? f.name : f.key }));
}

/** A plan as printed: always carries `features` (empty when it sells none). */
function withFeatures<T>(plan: T): T {
  if (!plan || typeof plan !== 'object') return plan;
  return { ...plan, features: featuresOf(plan) } as T;
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

// ── Product decisions (TBP-713) ──────────────────────────────────────────────
// Mirrors bridge-api's create_plan / set_plan_price / apply_plan: a price,
// interval, currency or trial the developer has not decided stops the command
// before anything is written, naming the same fields as the MCP tool.

/** The distinct currencies of a plan's prices, upper-cased. */
function planCurrencies(prices: Array<{ currency?: string }>): string[] {
  return [...new Set(prices.map((p) => p.currency?.trim().toUpperCase()).filter((c): c is string => !!c))];
}

/**
 * The currency for a price given without one: the plan's one currency when it
 * has exactly one; USD for a free (0) price when it has none; otherwise
 * undefined — the developer decides. Same rule as the MCP tools. Pure.
 */
export function resolvePriceCurrency(
  given: string | undefined,
  amount: number,
  others: Array<{ currency?: string }>,
): string | undefined {
  if (given !== undefined) return given.trim().toUpperCase();
  const known = planCurrencies(others);
  if (known.length === 1) return known[0];
  return amount === 0 && known.length === 0 ? 'USD' : undefined;
}

/** The decisions `plan create` is missing, in the MCP tool's order. Pure. */
export function createPlanDecisions(opts: {
  amount?: number;
  interval?: string;
  currency?: string;
  trial?: boolean;
  trialDays?: number;
}): DecisionField[] {
  const missing: DecisionField[] = [];
  const trial = opts.trial ?? (opts.trialDays !== undefined ? true : undefined);
  const paidOrUnknown = opts.amount === undefined || opts.amount > 0;
  if (opts.amount === undefined) missing.push(decisionField('create_plan', 'amount', '--amount <n>'));
  if (opts.interval === undefined) missing.push(decisionField('create_plan', 'interval', '--interval <interval>'));
  if (paidOrUnknown && opts.currency === undefined) missing.push(decisionField('create_plan', 'currency', '--currency <code>'));
  if (paidOrUnknown && trial === undefined) missing.push(decisionField('create_plan', 'trial', '--trial | --no-trial'));
  if (trial === true && opts.trialDays === undefined) missing.push(decisionField('create_plan', 'trialDays', '--trial-days <n>'));
  return missing;
}

/** Fetch a plan + its quotas/prices (read defensively — list() may omit them). */
async function getPlan(
  key: string,
): Promise<{ plan: Record<string, unknown>; quotas: Quota[]; prices: PlanPriceInput[]; features: PlanFeature[] }> {
  const plans = (await getManagementClient().plans.list()) as unknown as Record<string, unknown>[];
  const plan = plans.find((p) => p.key === key);
  if (!plan) throw new Error(`Plan not found: ${key}`);
  const quotas = ((plan as { quotas?: Quota[] }).quotas ?? []) as Quota[];
  const prices = ((plan as { prices?: PlanPriceInput[] }).prices ?? []) as PlanPriceInput[];
  return { plan, quotas, prices, features: featuresOf(plan) };
}

export function registerPlanCommands(program: Command): void {
  const plan = program.command('plan').description('Manage subscription plans');

  plan.command('list')
    .description('List all subscription plans')
    .action(async () => {
      try { outputSuccess((await getManagementClient().plans.list()).map((p) => withFeatures(shapePlan(p)))); }
      catch (err) { outputError(err); }
    });

  plan.command('get')
    .description('Get a plan by key (includes usage quotas and included features)')
    .argument('<key>', 'Plan key')
    .action(async (key: string) => {
      try {
        const { plan: found, quotas, features } = await getPlan(key);
        outputSuccess(shapePlan({ ...found, quotas, features }));
      } catch (err) { outputError(err); }
    });

  plan.command('create')
    .description('Create a new plan with its first price (add more with `plan price set`)')
    .requiredOption('--key <key>', 'Plan key')
    .requiredOption('--name <name>', 'Plan name')
    .option('--amount <amount>', 'First price amount (>= 0). Use 0 for a free or contact-sales tier', parseFloat)
    .option('--interval <interval>', `Billing interval for the first price: ${VALID_INTERVALS.join(' | ')}`)
    .option('--currency <currency>', 'Currency for the first price (ISO code). Required when --amount is above 0')
    .option('--description <desc>', 'Description')
    .option('--trial', 'The plan has a free trial (with --trial-days)')
    .option('--no-trial', 'The plan has no free trial. One of --trial / --no-trial is required when --amount is above 0')
    .option('--trial-days <days>', 'Trial period in days', parseInt)
    .option(
      '--features <list>',
      'On/off features the plan includes, comma-separated `key` or `key:Display Name`, e.g. "analytics,sso:Single sign-on". ' +
        'Each is `bridge:billing.entitlement.<key>` in flag rules',
    )
    .action(async (opts) => {
      try {
        // TBP-755 — validate before anything else so a bad key never half-creates a plan.
        const features = opts.features !== undefined ? parseFeaturesOption(String(opts.features)) : undefined;
        // TBP-713 — price, interval, currency and trial are the developer's
        // decisions: stop and name them instead of defaulting.
        const missing = createPlanDecisions(opts);
        if (missing.length) {
          throw new DecisionNeededError(
            'bridge plan create',
            missing,
            opts.amount === undefined ? 'currency and trial are not needed if the price is 0.' : undefined,
          );
        }
        // TBP-617 — the server rejects an explicitly empty price list, so build
        // (and validate) the first price here rather than sending `prices: []`.
        const prices = buildCreatePlanPrices({
          amount: opts.amount,
          interval: opts.interval,
          currency: opts.currency,
        });
        const trial = opts.trial ?? (opts.trialDays !== undefined ? true : false);
        outputSuccess(shapePlan(await getManagementClient().plans.create({
          key: opts.key,
          name: opts.name,
          description: opts.description,
          trial,
          trialDays: opts.trialDays,
          prices,
          ...(features && features.length ? { features } : {}),
        } as never)));
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
        outputSuccess(shapePlan(await getManagementClient().plans.update(key, cleaned)));
      } catch (err) { outputError(err); }
    });

  plan.command('apply')
    .description('Set up or reshape one plan in a single write: name, trial, prices and quotas together (creates it when the key is new)')
    .requiredOption(
      '--spec <json>',
      'The plan as JSON, or @file.json: { key, name?, description?, trial?, trialDays?, ' +
        'prices?: [{ amount, interval, currency? }], quotas?: [{ metric, limit, policy, kind?, priceAmount?, priceCurrency? }], ' +
        'features?: [{ key, name? }], removePrices?: [{ interval, currency? }], removeQuotas?: [metric], removeFeatures?: [key] }. ' +
        'Same shape as the MCP apply_plan tool. Prices, quotas and features are upserted; anything not mentioned is kept',
    )
    .action(async (opts) => {
      try {
        const spec = parsePlanSpec(opts.spec);
        const plans = (await getManagementClient().plans.list()) as unknown as Array<Record<string, unknown>>;
        const write = planApplyWrite(spec, plans);
        const result = write.created
          ? await getManagementClient().plans.create(write.body as never)
          : await getManagementClient().plans.update(spec.key, write.body as never);
        outputSuccess({ created: write.created, plan: shapePlan(result) });
      } catch (err) { outputError(err); }
    });

  registerPriceCommands(plan);
  registerQuotaCommands(plan);
  registerFeatureCommands(plan);
}

// ── plan apply (TBP-709) ─────────────────────────────────────────────────────
// Mirrors the MCP apply_plan tool: one write per plan, prices upserted by
// currency + interval, quotas by metric, only the named ones removed, and the
// same refusals (same codes) before anything is written.

export interface PlanSpec {
  key: string;
  name?: string;
  description?: string;
  trial?: boolean;
  trialDays?: number;
  prices?: Array<{ amount: number; interval: string; currency?: string }>;
  quotas?: Array<{ metric: string; limit: number; policy: string; kind?: string; priceAmount?: number; priceCurrency?: string }>;
  removePrices?: Array<{ interval: string; currency?: string }>;
  removeQuotas?: string[];
  /** TBP-755 — on/off features, upserted by key. */
  features?: Array<{ key: string; name?: string }>;
  /** TBP-755 — feature keys to remove. */
  removeFeatures?: string[];
}

/** An error with a machine-readable code, reported by outputError. */
export class PlanApplyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlanApplyError';
  }
}

/** Read `--spec` as inline JSON or `@path`. */
export function parsePlanSpec(raw: string): PlanSpec {
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  let spec: PlanSpec;
  try {
    spec = JSON.parse(text) as PlanSpec;
  } catch (err) {
    throw new PlanApplyError('INVALID_SPEC', `--spec is not valid JSON: ${(err as Error).message}`);
  }
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || !spec.key) {
    throw new PlanApplyError('INVALID_SPEC', '--spec needs a "key", e.g. {"key":"pro","name":"Pro","prices":[{"amount":29,"interval":"month"}]}.');
  }
  return spec;
}

/** The one write `plan apply` makes: a create body or an update body. Pure. */
export function planApplyWrite(
  spec: PlanSpec,
  plans: Array<Record<string, unknown>>,
): { created: boolean; body: Record<string, unknown> } {
  const key = spec.key;
  const current = plans.find((p) => p.key === key);
  const isNew = !current;

  const before: PlanPriceInput[] = isNew ? [] : [...(((current as { prices?: PlanPriceInput[] }).prices ?? []))];
  let prices: PlanPriceInput[] = [...before];
  const planCurrency = planCurrencies(before).length === 1 ? planCurrencies(before)[0] : 'USD';
  for (const r of spec.removePrices ?? []) {
    const currency = (r.currency ?? planCurrency).trim().toUpperCase();
    const slot = (p: PlanPriceInput) => p.currency === currency && p.recurrenceInterval === r.interval;
    if (!prices.some(slot)) {
      throw new PlanApplyError('PRICE_NOT_FOUND', `No ${currency} ${r.interval} price on plan "${key}". Nothing was changed.`);
    }
    prices = prices.filter((p) => !slot(p));
  }
  // TBP-713 — the product decisions, gathered and reported all at once before
  // anything is written; same fields, same order as the MCP apply_plan tool.
  const missing: DecisionField[] = [];
  const inputs = spec.prices ?? [];
  const settled = [...before, ...inputs.filter((p) => p.currency !== undefined)];
  inputs.forEach((p, i) => {
    const currency = resolvePriceCurrency(p.currency, p.amount, settled);
    if (!currency) {
      missing.push(decisionField('apply_plan', 'prices.currency', `"prices[${i}].currency"`, `prices[${i}].currency`));
      return;
    }
    prices = upsertPrice(prices, buildPriceEntry({ amount: p.amount, interval: p.interval, currency }));
  });
  if (prices.length === 0 && !isNew && missing.length === 0) {
    throw new PlanApplyError('LAST_PRICE', `This would remove every price from plan "${key}": a plan needs at least one price. Nothing was changed.`);
  }
  if (isNew && spec.name === undefined) missing.push(decisionField('apply_plan', 'name', '"name"'));
  if (isNew && inputs.length === 0) {
    missing.push(
      decisionField('apply_plan', 'prices.amount', '"prices[0].amount"', 'prices[0].amount'),
      decisionField('apply_plan', 'prices.interval', '"prices[0].interval"', 'prices[0].interval'),
      decisionField('apply_plan', 'prices.currency', '"prices[0].currency"', 'prices[0].currency'),
    );
  }
  const trial = spec.trial ?? (spec.trialDays !== undefined ? true : undefined);
  const paid = inputs.length === 0 || inputs.some((p) => p.amount > 0);
  if (isNew && paid && trial === undefined) missing.push(decisionField('apply_plan', 'trial', '"trial"'));
  const currentTrialDays = (current as { trialDays?: number } | undefined)?.trialDays;
  if (trial === true && spec.trialDays === undefined && !currentTrialDays) {
    missing.push(decisionField('apply_plan', 'trialDays', '"trialDays"'));
  }
  if (missing.length) {
    throw new DecisionNeededError(
      'bridge plan apply',
      missing,
      isNew ? `Plan "${key}" does not exist yet, so this call would create it.` : undefined,
    );
  }

  let quotas: Quota[] = isNew ? [] : [...(((current as { quotas?: Quota[] }).quotas ?? []))];
  for (const metric of spec.removeQuotas ?? []) {
    if (!quotas.some((q) => q.metric === metric)) {
      throw new PlanApplyError('QUOTA_NOT_FOUND', `No quota for metric "${metric}" on plan "${key}". Nothing was changed.`);
    }
    quotas = quotas.filter((q) => q.metric !== metric);
  }
  const currencies = [...new Set(prices.map((p) => p.currency.toUpperCase()))];
  for (const q of spec.quotas ?? []) {
    const existingKind = quotas.find((e) => e.metric === String(q.metric ?? '').trim())?.kind;
    let entry: Quota;
    try {
      entry = validateQuotaEntry({
        metric: q.metric,
        limit: q.limit,
        policy: q.policy,
        kind: q.kind ?? existingKind,
        priceAmount: q.priceAmount,
        currency: q.priceCurrency ?? (currencies.length === 1 ? currencies[0] : undefined),
      });
    } catch (err) {
      throw new PlanApplyError('INVALID_QUOTA', (err as Error).message);
    }
    quotas = upsertQuota(quotas, entry);
  }

  // TBP-755 — features: current, minus removals, with upserts by key.
  let features: PlanFeature[] = isNew ? [] : featuresOf(current);
  for (const fk of spec.removeFeatures ?? []) {
    if (!features.some((f) => f.key === fk)) {
      throw new PlanApplyError('FEATURE_NOT_FOUND', `No feature "${fk}" on plan "${key}". Nothing was changed.`);
    }
    features = features.filter((f) => f.key !== fk);
  }
  for (const f of spec.features ?? []) {
    let entry: PlanFeature;
    try {
      entry = buildFeature(String(f?.key ?? ''), f?.name);
    } catch (err) {
      throw new PlanApplyError('INVALID_FEATURE', (err as Error).message);
    }
    features = upsertFeature(features, entry);
  }
  const featuresTouched = spec.features !== undefined || spec.removeFeatures !== undefined;

  const fields: Record<string, unknown> = {};
  for (const f of ['name', 'description', 'trialDays'] as const) {
    if (spec[f] !== undefined) fields[f] = spec[f];
  }
  if (trial !== undefined) fields.trial = trial;
  if (isNew) {
    return {
      created: true,
      body: {
        key,
        trial: false,
        ...fields,
        prices,
        ...(quotas.length ? { quotas } : {}),
        ...(features.length ? { features } : {}),
      },
    };
  }
  return {
    created: false,
    body: {
      ...fields,
      ...(spec.prices !== undefined || spec.removePrices !== undefined ? { prices } : {}),
      ...(spec.quotas !== undefined || spec.removeQuotas !== undefined ? { quotas } : {}),
      ...(featuresTouched ? { features } : {}),
    },
  };
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
    .option('--currency <currency>', "Currency (ISO code). Omit only to reuse the plan's one existing price currency")
    .action(async (key: string, opts) => {
      try {
        const { prices } = await getPlan(key);
        // TBP-713 — never price in a currency the developer did not choose.
        const currency = resolvePriceCurrency(opts.currency, opts.amount, prices);
        if (!currency) {
          throw new DecisionNeededError(
            'bridge plan price set',
            [decisionField('set_plan_price', 'currency', '--currency <code>')],
            `Plan "${key}" has prices in ${planCurrencies(prices).join(', ') || 'no currency yet'}, so there is none to reuse.`,
          );
        }
        const entry = buildPriceEntry({
          amount: opts.amount,
          interval: opts.interval,
          currency,
        });
        const next = upsertPrice(prices, entry);
        outputSuccess(shapePlan(await getManagementClient().plans.update(key, { prices: next })));
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
        outputSuccess(shapePlan(await getManagementClient().plans.update(key, { prices: next })));
      } catch (err) { outputError(err); }
    });
}

// ── plan quota (usage caps) ──────────────────────────────────────────────────

function registerQuotaCommands(plan: Command): void {
  const quota = plan
    .command('quota')
    .description('Manage a plan\'s usage quotas (hard | metered caps, counter | gauge kinds)');

  quota.command('list')
    .description('List the usage quotas on a plan, or with no key every metric across all plans with its kind')
    .argument('[key]', 'Plan key (omit to list every metric name and kind across all plans)')
    .action(async (key: string | undefined) => {
      try {
        if (key === undefined) {
          const plans = (await getManagementClient().plans.list()) as unknown as Array<{
            key?: unknown;
            quotas?: Quota[];
          }>;
          outputSuccess(listMetrics(plans));
          return;
        }
        const { quotas } = await getPlan(key);
        outputSuccess((shapePlan({ quotas }).quotas ?? []).map((q) => ({ ...q, kind: quotaKindOf(q) })));
      } catch (err) { outputError(err); }
    });

  quota.command('set')
    .description('Add or update a usage quota on a plan')
    .argument('<key>', 'Plan key')
    .requiredOption('--metric <metric>', 'Metric key (e.g. num.clicks)')
    .requiredOption('--limit <n>', 'Limit (integer >= 0). 0 = pure per-unit metered (billed from unit 1)', parseInt)
    .requiredOption('--policy <policy>', `Cap policy: ${QUOTA_POLICIES.join(' | ')}`)
    .option(
      '--kind <kind>',
      `${QUOTA_KINDS.join(' | ')}. counter (default) = summed per billing period; gauge = absolute value your app sets, never reset. ` +
        "If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it. " +
        'Omit to keep an existing quota\'s kind',
    )
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
        // TBP-699 — an omitted --kind keeps the existing quota's kind.
        const existingKind = quotas.find((q) => q.metric === String(opts.metric ?? '').trim())?.kind;
        const entry = validateQuotaEntry({
          metric: opts.metric,
          limit: opts.limit,
          policy: opts.policy,
          kind: opts.kind ?? existingKind,
          priceAmount: opts.priceAmount,
          currency,
        });
        const next = upsertQuota(quotas, entry);
        outputSuccess(shapePlan(await getManagementClient().plans.update(key, { quotas: next } as never)));
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
        outputSuccess(shapePlan(await getManagementClient().plans.update(key, { quotas: next } as never)));
      } catch (err) { outputError(err); }
    });
}

// ── plan feature (included on/off features, TBP-755) ─────────────────────────

function registerFeatureCommands(plan: Command): void {
  const feature = plan
    .command('feature')
    .description(
      'Manage the on/off features a plan includes. Each is `bridge:billing.entitlement.<key>` in flag rules: ' +
        'gate a feature with the rule `bridge:billing.entitlement.<key> eq true`',
    );

  feature.command('list')
    .description('List the features a plan includes')
    .argument('<planKey>', 'Plan key')
    .action(async (planKey: string) => {
      try {
        outputSuccess((await getPlan(planKey)).features);
      } catch (err) { outputError(err); }
    });

  feature.command('add')
    .description('Add a feature to a plan, or rename one it already includes (idempotent by key)')
    .argument('<planKey>', 'Plan key')
    .argument('<featureKey>', 'Feature key: lower-case letters, digits and underscores, e.g. analytics')
    .option('--name <name>', 'Display name shown on the pricing table and upgrade dialog (default: the key)')
    .action(async (planKey: string, featureKey: string, opts) => {
      try {
        const entry = buildFeature(featureKey, opts.name);
        const { features } = await getPlan(planKey);
        const next = upsertFeature(features, entry);
        outputSuccess(withFeatures(shapePlan(await getManagementClient().plans.update(planKey, { features: next } as never))));
      } catch (err) { outputError(err); }
    });

  feature.command('remove')
    .description('Remove a feature from a plan')
    .argument('<planKey>', 'Plan key')
    .argument('<featureKey>', 'Feature key to remove')
    .action(async (planKey: string, featureKey: string) => {
      try {
        const { features } = await getPlan(planKey);
        const next = removeFeature(features, featureKey, planKey);
        outputSuccess(withFeatures(shapePlan(await getManagementClient().plans.update(planKey, { features: next } as never))));
      } catch (err) { outputError(err); }
    });
}
