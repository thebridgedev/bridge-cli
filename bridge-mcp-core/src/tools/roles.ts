import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Read-only list of the app's access roles with their privileges.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const listRolesTool: BridgeToolDefinition<{}> = {
  name: 'list_roles',
  description:
    'List every access role in the Bridge app with its privileges. Each role includes: ' +
    'key, name, description, whether it is the default role for new users, and the ' +
    'full list of privileges it grants (privilege key + description). Use this when ' +
    'wiring role- or privilege-gated routes/components, checking which role to assign ' +
    'a user, or verifying a privilege key exists before referencing it in code. For ' +
    'login-method configuration use get_auth_config; for the whole app object use get_app.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const roles = await ctx.management.roles.list();
      return { success: true, data: { roles } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
