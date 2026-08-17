import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Read-only list of every feature flag with its full targeting setup.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const listFeatureFlagsTool: BridgeToolDefinition<{}> = {
  name: 'list_feature_flags',
  description:
    'List every feature flag in the Bridge app with its full targeting rules and state. ' +
    'Each flag includes: key, description, lifecycle state (on/off/conditional), value ' +
    'type and on/off values, the FF 2.0 targeting rule tree, legacy segments, any ' +
    'scheduled state transition, and evaluation stats (evalCount, lastEvalAt). Use this ' +
    'when working with flags — verifying a flag key exists before referencing it in ' +
    'code, or inspecting targeting before relying on a flag. For app-level auth/config ' +
    'use get_app or get_auth_config instead; for project wiring use get_environment_info.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const flags = await ctx.management.flags.list();
      return { success: true, data: { flags } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
