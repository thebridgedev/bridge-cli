import { z } from 'zod';
import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * User write tool — mirrors `bridge user invite`. The CLI resolves the tenant
 * from --tenant-id or BRIDGE_TENANT_ID; MCP has no ambient tenant context, so
 * tenantId is an explicit required argument.
 */
export const inviteUserTool: BridgeToolDefinition<{
  tenantId: z.ZodString;
  email: z.ZodString;
  role: z.ZodOptional<z.ZodString>;
  firstName: z.ZodOptional<z.ZodString>;
  lastName: z.ZodOptional<z.ZodString>;
}> = {
  name: 'invite_user',
  description:
    'Invite a user to a tenant by email (the platform sends the invitation and creates the ' +
    'user). Arguments: tenantId (required — a tenant id from create_tenant or the tenant ' +
    'list), email (the invitee), role (a role KEY from list_roles, e.g. "ADMIN"; the ' +
    "app's default role is used when omitted), firstName, lastName. Use create_tenant " +
    'first when the tenant does not exist yet.',
  inputSchema: {
    tenantId: z.string().min(1, 'tenantId must be the id of an existing tenant.'),
    email: z.string().email('email must be a valid email address, e.g. "user@example.com".'),
    role: z
      .string()
      .min(1)
      .optional()
      .describe("Role KEY from list_roles; defaults to the app's default role."),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
  },
  handler: async (ctx, args) => {
    try {
      const user = await ctx.management.users.invite(args.tenantId as string, {
        username: args.email as string,
        role: args.role as string | undefined,
        firstName: args.firstName as string | undefined,
        lastName: args.lastName as string | undefined,
      });
      return { success: true, data: user };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
