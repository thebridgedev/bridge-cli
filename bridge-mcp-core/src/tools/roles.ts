import { z } from 'zod';
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

// ── Role write tools (mirror `bridge role create/update`) ───────────────────

/**
 * Create an access role.
 */
export const createRoleTool: BridgeToolDefinition<{
  name: z.ZodString;
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  privileges: z.ZodOptional<z.ZodArray<z.ZodString>>;
  isDefault: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'create_role',
  description:
    'Create a new access role. Arguments: name (display name), key (stable identifier code ' +
    'references, e.g. "ADMIN"), description, privileges (list of privilege KEYS the role ' +
    'grants — see list_roles for the keys existing roles use), and isDefault (make this the ' +
    'role assigned to new users; default false). Use update_role to change an existing role.',
  inputSchema: {
    name: z.string().min(1, 'name must be a non-empty display name, e.g. "Admin".'),
    key: z.string().min(1, 'key must be a non-empty role key, e.g. "ADMIN".'),
    description: z.string().optional(),
    privileges: z
      .array(z.string().min(1))
      .optional()
      .describe('Privilege keys the role grants (default: none).'),
    isDefault: z.boolean().optional().describe('Make this the default role for new users (default false).'),
  },
  handler: async (ctx, args) => {
    try {
      const role = await ctx.management.roles.create({
        name: args.name as string,
        key: args.key as string,
        description: args.description as string | undefined,
        privileges: (args.privileges as string[] | undefined) ?? [],
        isDefault: (args.isDefault as boolean | undefined) ?? false,
      });
      return { success: true, data: role };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Update an access role by id.
 */
export const updateRoleTool: BridgeToolDefinition<{
  id: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  privileges: z.ZodOptional<z.ZodArray<z.ZodString>>;
}> = {
  name: 'update_role',
  description:
    'Update an existing access role by its id (get the id from list_roles). Only the fields ' +
    'you pass are changed: name, description, privileges. NOTE: privileges REPLACES the whole ' +
    'privilege list — read the current list from list_roles first and pass the full desired ' +
    'set, or privileges not included are revoked.',
  inputSchema: {
    id: z.string().min(1, 'id must be the role id from list_roles.'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    privileges: z
      .array(z.string().min(1))
      .optional()
      .describe('Full replacement privilege list (omitted privileges are revoked).'),
  },
  handler: async (ctx, args) => {
    try {
      const data: { name?: string; description?: string; privileges?: string[] } = {};
      if (args.name !== undefined) data.name = args.name as string;
      if (args.description !== undefined) data.description = args.description as string;
      if (args.privileges !== undefined) data.privileges = args.privileges as string[];
      const role = await ctx.management.roles.update(args.id as string, data);
      return { success: true, data: role };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
