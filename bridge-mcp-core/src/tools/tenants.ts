import { z } from 'zod';
import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Tenant write tool — mirrors `bridge tenant create` (owner email + optional
 * name/plan/locale; the owner user is created/invited by the platform).
 */
export const createTenantTool: BridgeToolDefinition<{
  ownerEmail: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  plan: z.ZodOptional<z.ZodString>;
  locale: z.ZodOptional<z.ZodString>;
}> = {
  name: 'create_tenant',
  description:
    'Create a new tenant (workspace/customer account) in the Bridge app. Arguments: ' +
    'ownerEmail (required — the owner user is created and invited by the platform), name ' +
    '(tenant display name), plan (a plan KEY from list_plans, e.g. "pro" — note this is the ' +
    'key, unlike feature-flag rules which use plan names), locale (ISO 639-1, e.g. "en"). ' +
    'Use invite_user to add more users to the tenant afterwards.',
  inputSchema: {
    ownerEmail: z
      .string()
      .email('ownerEmail must be a valid email address, e.g. "owner@example.com".'),
    name: z.string().min(1).optional().describe('Tenant display name.'),
    plan: z.string().min(1).optional().describe('Plan KEY from list_plans (not the plan name).'),
    locale: z.string().min(1).optional().describe('ISO 639-1 locale, e.g. "en".'),
  },
  handler: async (ctx, args) => {
    try {
      const tenant = await ctx.management.tenants.create({
        owner: { email: args.ownerEmail as string },
        name: args.name as string | undefined,
        plan: args.plan as string | undefined,
        locale: args.locale as string | undefined,
      });
      return { success: true, data: tenant };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
