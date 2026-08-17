import type { BridgeToolDefinition } from '../types.js';

/**
 * Read-only view of the Bridge app configuration. First tool through the
 * seam; description is written for an agent audience.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const getAppTool: BridgeToolDefinition<{}> = {
  name: 'get_app',
  description:
    'Read the full Bridge app configuration: name, URLs, enabled login methods, ' +
    'registered redirect URIs, default role, plan/billing setup and other app-level ' +
    'settings. Call this first to understand how the app is configured before ' +
    'changing anything or diagnosing auth issues.',
  inputSchema: {},
  handler: async (ctx) => {
    const data = await ctx.management.app.get();
    return { success: true, data };
  },
};
