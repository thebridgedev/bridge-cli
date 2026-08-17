import { z } from 'zod';
import type { CreatePlanRequest, PlanPrice } from '@nebulr-group/bridge-auth-core';
import type { BridgeToolDefinition, ToolContext, ToolResult } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Read-only list of the app's subscription plans, including prices and quotas.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const listPlansTool: BridgeToolDefinition<{}> = {
  name: 'list_plans',
  description:
    'List every subscription plan in the Bridge app, with prices AND quota properties. ' +
    'Each plan includes: key, name, description, trial settings (trial, trialDays), ' +
    'prices (amount, currency, recurrence interval) and per-metric usage quotas ' +
    '(metric, limit, hard-cap vs metered policy, and per-unit pricing for metered ' +
    'quotas). Use this for billing, entitlement and quota questions — e.g. which plan ' +
    'key to reference in code, or what limits a plan enforces. For whether Stripe/' +
    'payments are enabled at the app level, use get_app.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const plans = await ctx.management.plans.list();
      return { success: true, data: { plans } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

// ── Plan write tools ────────────────────────────────────────────────────────
//
// Mirror the CLI's `plan create/update` + `plan price set/rm` + `plan quota
// set/rm` request shapes exactly (bridge-cli/src/commands/plan.command.ts).
// Prices and quotas live as arrays ON the plan and the management API only
// exposes whole-plan update, so price/quota tools are read-modify-write:
// fetch the plan, upsert/filter the array, write it back.

/** Same shape as the CLI's Quota type — the published management plan types
 * don't export the quota entry type, so we mirror it locally (same pattern as
 * plan.command.ts). */
interface QuotaEntry {
  metric: string;
  limit: number;
  policy: 'hard' | 'metered';
  /** Required for `metered`, forbidden for `hard`. */
  pricing?: { amount: number; currency: string };
}

const INTERVALS = ['day', 'week', 'month', 'year'] as const;

const intervalSchema = z
  .enum(INTERVALS)
  .describe('Billing recurrence interval.');

/** Fetch a plan + its prices/quotas (read defensively — list() may omit them),
 * or a PLAN_NOT_FOUND failure envelope. */
async function getPlanByKey(
  ctx: ToolContext,
  key: string,
): Promise<
  | { ok: true; quotas: QuotaEntry[]; prices: PlanPrice[]; planKeys: string[] }
  | { ok: false; failure: ToolResult }
> {
  const plans = (await ctx.management.plans.list()) as unknown as Record<string, unknown>[];
  const plan = plans.find((p) => p.key === key);
  const planKeys = plans.map((p) => String(p.key));
  if (!plan) {
    return {
      ok: false,
      failure: {
        success: false,
        error: {
          code: 'PLAN_NOT_FOUND',
          message: `Plan not found: ${key}`,
          fix: `Existing plan keys: ${planKeys.length ? planKeys.join(', ') : '(none)'}. Use list_plans, or create_plan to create it.`,
        },
      },
    };
  }
  return {
    ok: true,
    quotas: ((plan as { quotas?: QuotaEntry[] }).quotas ?? []) as QuotaEntry[],
    prices: ((plan as { prices?: PlanPrice[] }).prices ?? []) as PlanPrice[],
    planKeys,
  };
}

/**
 * Create a plan (no prices — add them with set_plan_price).
 */
export const createPlanTool: BridgeToolDefinition<{
  key: z.ZodString;
  name: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  trial: z.ZodOptional<z.ZodBoolean>;
  trialDays: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'create_plan',
  description:
    'Create a new subscription plan. Arguments: key (required — stable identifier code and ' +
    'billing reference, e.g. "pro"), name (required — the display name; note that feature-flag ' +
    'rules reference plans by this NAME), description, trial (include a trial period) and ' +
    'trialDays. The plan is created with NO prices so the server does not apply a placeholder ' +
    'price — add prices explicitly with set_plan_price, and usage quotas with set_plan_quota. ' +
    'Use update_plan to change name/description later.',
  inputSchema: {
    key: z.string().min(1, 'key must be a non-empty plan key, e.g. "pro".'),
    name: z.string().min(1, 'name must be a non-empty display name, e.g. "Pro".'),
    description: z.string().optional(),
    trial: z.boolean().optional().describe('Include a trial period (default false).'),
    trialDays: z.number().int().positive().optional().describe('Trial period length in days.'),
  },
  handler: async (ctx, args) => {
    try {
      const payload: CreatePlanRequest = {
        key: args.key as string,
        name: args.name as string,
        description: args.description as string | undefined,
        trial: (args.trial as boolean | undefined) ?? false,
        trialDays: args.trialDays as number | undefined,
        // Start with no prices so the server doesn't apply its default
        // placeholder price; add prices explicitly via set_plan_price.
        prices: [],
      };
      const plan = await ctx.management.plans.create(payload);
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Update a plan's name/description by key.
 */
export const updatePlanTool: BridgeToolDefinition<{
  key: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
}> = {
  name: 'update_plan',
  description:
    'Update an existing subscription plan by its key. Only the fields you pass are changed: ' +
    'name (the display name feature-flag rules reference), description. Prices and quotas are ' +
    'NOT updated here — use set_plan_price / remove_plan_price and set_plan_quota / ' +
    'remove_plan_quota instead.',
  inputSchema: {
    key: z.string().min(1, 'key must be the plan key, e.g. "pro" (see list_plans).'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  },
  handler: async (ctx, args) => {
    try {
      const data: { name?: string; description?: string } = {};
      if (args.name !== undefined) data.name = args.name as string;
      if (args.description !== undefined) data.description = args.description as string;
      const plan = await ctx.management.plans.update(args.key as string, data);
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Add or update a recurring price on a plan (idempotent by currency + interval).
 */
export const setPlanPriceTool: BridgeToolDefinition<{
  key: z.ZodString;
  amount: z.ZodNumber;
  interval: typeof intervalSchema;
  currency: z.ZodOptional<z.ZodString>;
}> = {
  name: 'set_plan_price',
  description:
    'Add or update a recurring price on a plan. A plan can carry several prices (e.g. ' +
    'monthly + yearly); each is identified by its currency + interval, and setting one is ' +
    'idempotent — an existing price for the same currency + interval is replaced, others are ' +
    'preserved. Arguments: key (plan key), amount (>= 0), interval (day | week | month | ' +
    'year), currency (default USD). Use remove_plan_price to delete a price.',
  inputSchema: {
    key: z.string().min(1, 'key must be the plan key (see list_plans).'),
    amount: z.number().min(0, 'amount must be a number >= 0.'),
    interval: intervalSchema,
    currency: z.string().min(1).optional().describe('ISO currency code, default USD.'),
  },
  handler: async (ctx, args) => {
    try {
      const entry: PlanPrice = {
        amount: args.amount as number,
        currency: ((args.currency as string | undefined) ?? 'USD').trim().toUpperCase(),
        recurrenceInterval: args.interval as PlanPrice['recurrenceInterval'],
      };
      const found = await getPlanByKey(ctx, args.key as string);
      if (!found.ok) return found.failure;
      const next = [
        ...found.prices.filter(
          (p) =>
            !(p.currency === entry.currency && p.recurrenceInterval === entry.recurrenceInterval),
        ),
        entry,
      ];
      const plan = await ctx.management.plans.update(args.key as string, { prices: next });
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Remove a price from a plan by interval (+ currency).
 */
export const removePlanPriceTool: BridgeToolDefinition<{
  key: z.ZodString;
  interval: typeof intervalSchema;
  currency: z.ZodOptional<z.ZodString>;
}> = {
  name: 'remove_plan_price',
  description:
    'Remove a recurring price from a plan, identified by interval (day | week | month | year) ' +
    'and currency (default USD). Fails with PRICE_NOT_FOUND when the plan has no price for ' +
    'that currency + interval; other prices are preserved.',
  inputSchema: {
    key: z.string().min(1, 'key must be the plan key (see list_plans).'),
    interval: intervalSchema,
    currency: z.string().min(1).optional().describe('ISO currency code, default USD.'),
  },
  handler: async (ctx, args) => {
    try {
      const currency = ((args.currency as string | undefined) ?? 'USD').trim().toUpperCase();
      const interval = args.interval as PlanPrice['recurrenceInterval'];
      const found = await getPlanByKey(ctx, args.key as string);
      if (!found.ok) return found.failure;
      const next = found.prices.filter(
        (p) => !(p.currency === currency && p.recurrenceInterval === interval),
      );
      if (next.length === found.prices.length) {
        return {
          success: false,
          error: {
            code: 'PRICE_NOT_FOUND',
            message: `No ${currency} ${interval} price on plan "${args.key}".`,
            fix: `Existing prices: ${
              found.prices.length
                ? found.prices
                    .map((p) => `${p.currency} ${p.recurrenceInterval} ${p.amount}`)
                    .join(', ')
                : '(none)'
            }.`,
          },
        };
      }
      const plan = await ctx.management.plans.update(args.key as string, { prices: next });
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Add or update a usage quota on a plan (idempotent by metric).
 */
export const setPlanQuotaTool: BridgeToolDefinition<{
  key: z.ZodString;
  metric: z.ZodString;
  limit: z.ZodNumber;
  policy: z.ZodEnum<['hard', 'metered']>;
  priceAmount: z.ZodOptional<z.ZodNumber>;
  priceCurrency: z.ZodOptional<z.ZodString>;
}> = {
  name: 'set_plan_quota',
  description:
    'Add or update a per-metric usage quota on a plan (idempotent by metric — an existing ' +
    'quota for the same metric is replaced, others preserved). Arguments: key (plan key), ' +
    'metric (e.g. "num.clicks"), limit (integer >= 0; 0 = pure per-unit metered, billed from ' +
    'unit 1), policy ("hard" blocks at the limit; "metered" bills per unit above it). Metered ' +
    'quotas require priceAmount (> 0, per-unit) and a currency — priceCurrency defaults to ' +
    "the plan's price currency when the plan has exactly one; pass it explicitly otherwise. " +
    'Hard quotas must NOT carry priceAmount. Use remove_plan_quota to delete a quota.',
  inputSchema: {
    key: z.string().min(1, 'key must be the plan key (see list_plans).'),
    metric: z.string().min(1, 'metric must be a non-empty metric key, e.g. "num.clicks".'),
    limit: z
      .number()
      .int('limit must be an integer >= 0.')
      .min(0, 'limit must be an integer >= 0.')
      .describe('Included units. 0 = pure per-unit metered (billed from unit 1).'),
    policy: z.enum(['hard', 'metered']),
    priceAmount: z
      .number()
      .optional()
      .describe('Per-unit price for metered quotas (required with policy=metered).'),
    priceCurrency: z
      .string()
      .min(1)
      .optional()
      .describe("Currency for the metered price (defaults to the plan's price currency when unambiguous)."),
  },
  handler: async (ctx, args) => {
    try {
      const key = args.key as string;
      const metric = (args.metric as string).trim();
      const policy = args.policy as QuotaEntry['policy'];
      const priceAmount = args.priceAmount as number | undefined;
      const found = await getPlanByKey(ctx, key);
      if (!found.ok) return found.failure;

      let entry: QuotaEntry;
      if (policy === 'metered') {
        if (typeof priceAmount !== 'number' || !Number.isFinite(priceAmount) || priceAmount <= 0) {
          return {
            success: false,
            error: {
              code: 'INVALID_QUOTA',
              message: `priceAmount must be a number > 0 for metered quotas, got "${priceAmount}".`,
              fix: 'Pass priceAmount (per-unit price) when policy is "metered".',
            },
          };
        }
        // Derive the metered currency from the plan's prices when not given and
        // unambiguous; the backend enforces currency == a plan price currency.
        const planCurrencies = [
          ...new Set(found.prices.map((p) => p.currency?.toUpperCase()).filter(Boolean)),
        ];
        const currency =
          (args.priceCurrency as string | undefined)?.trim().toUpperCase() ??
          (planCurrencies.length === 1 ? planCurrencies[0] : undefined);
        if (!currency) {
          return {
            success: false,
            error: {
              code: 'INVALID_QUOTA',
              message:
                'A currency is required for metered pricing. The plan has no single price currency to derive from.',
              fix: `Pass priceCurrency explicitly. Plan price currencies: ${
                planCurrencies.length ? planCurrencies.join(', ') : '(none)'
              }.`,
            },
          };
        }
        entry = { metric, limit: args.limit as number, policy, pricing: { amount: priceAmount, currency } };
      } else {
        if (priceAmount !== undefined) {
          return {
            success: false,
            error: {
              code: 'INVALID_QUOTA',
              message: 'priceAmount is only valid with policy "metered".',
              fix: 'Drop priceAmount, or set policy to "metered".',
            },
          };
        }
        entry = { metric, limit: args.limit as number, policy };
      }

      const next = [...found.quotas.filter((q) => q.metric !== metric), entry];
      const plan = await ctx.management.plans.update(key, { quotas: next } as never);
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Remove a usage quota from a plan by metric.
 */
export const removePlanQuotaTool: BridgeToolDefinition<{
  key: z.ZodString;
  metric: z.ZodString;
}> = {
  name: 'remove_plan_quota',
  description:
    'Remove a usage quota from a plan by its metric key. Fails with QUOTA_NOT_FOUND when the ' +
    'plan has no quota for that metric; other quotas are preserved.',
  inputSchema: {
    key: z.string().min(1, 'key must be the plan key (see list_plans).'),
    metric: z.string().min(1, 'metric must be the metric key of the quota to remove.'),
  },
  handler: async (ctx, args) => {
    try {
      const key = args.key as string;
      const metric = args.metric as string;
      const found = await getPlanByKey(ctx, key);
      if (!found.ok) return found.failure;
      const next = found.quotas.filter((q) => q.metric !== metric);
      if (next.length === found.quotas.length) {
        return {
          success: false,
          error: {
            code: 'QUOTA_NOT_FOUND',
            message: `No quota for metric "${metric}" on plan "${key}".`,
            fix: `Existing quota metrics: ${
              found.quotas.length ? found.quotas.map((q) => q.metric).join(', ') : '(none)'
            }.`,
          },
        };
      }
      const plan = await ctx.management.plans.update(key, { quotas: next } as never);
      return { success: true, data: plan };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
