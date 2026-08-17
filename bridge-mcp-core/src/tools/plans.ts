import type { BridgeToolDefinition } from '../types.js';
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
