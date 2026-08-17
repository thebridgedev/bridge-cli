import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type {
  AnyBridgeToolDefinition,
  BridgeToolDefinition,
  ToolContext,
  ToolResult,
} from './types.js';
import { addRedirectUriTool, getAppTool, removeRedirectUriTool } from './tools/app.js';
import {
  createFeatureFlagTool,
  listFeatureFlagsTool,
  toggleFeatureFlagTool,
  updateFeatureFlagTool,
} from './tools/flags.js';
import {
  createPlanTool,
  listPlansTool,
  removePlanPriceTool,
  removePlanQuotaTool,
  setPlanPriceTool,
  setPlanQuotaTool,
  updatePlanTool,
} from './tools/plans.js';
import { createRoleTool, listRolesTool, updateRoleTool } from './tools/roles.js';
import { getAuthConfigTool, updateAuthMethodsTool } from './tools/auth-config.js';
import { getEnvironmentInfoTool } from './tools/environment.js';
import { updateBrandingTool } from './tools/branding.js';
import { setupSsoTool } from './tools/sso.js';
import { createTenantTool } from './tools/tenants.js';
import { inviteUserTool } from './tools/users.js';

/**
 * Erase a fully-typed tool definition down to the registry's `AnyBridgeToolDefinition`.
 *
 * A handler typed against a shape with REQUIRED keys (e.g. `key: z.ZodString`)
 * is not structurally assignable to the erased handler signature (`args:
 * { [x: string]: any }` does not prove `key` present), so the erasure needs an
 * explicit cast. It is safe by construction: the registration loop below (and
 * the official MCP SDK) validate incoming arguments against the tool's own
 * `inputSchema` before the handler runs.
 */
function eraseTool<S extends z.ZodRawShape>(tool: BridgeToolDefinition<S>): AnyBridgeToolDefinition {
  return tool as unknown as AnyBridgeToolDefinition;
}

/**
 * The Bridge tool registry. Transport shells never enumerate tools
 * themselves — they call `registerBridgeTools` and get whatever this array
 * contains. Adding a tool to the platform means adding it here.
 *
 * Deliberately NO destructive tools (deletes, user removal, token revocation)
 * — those stay CLI-only where a human is at the keyboard.
 */
export const bridgeTools: AnyBridgeToolDefinition[] = [
  // Read tools
  getAppTool,
  listFeatureFlagsTool,
  listPlansTool,
  listRolesTool,
  getAuthConfigTool,
  getEnvironmentInfoTool,
  // Write tools (TBP-539 step 2b)
  eraseTool(createFeatureFlagTool),
  eraseTool(updateFeatureFlagTool),
  eraseTool(toggleFeatureFlagTool),
  eraseTool(createPlanTool),
  eraseTool(updatePlanTool),
  eraseTool(setPlanPriceTool),
  eraseTool(removePlanPriceTool),
  eraseTool(setPlanQuotaTool),
  eraseTool(removePlanQuotaTool),
  eraseTool(createRoleTool),
  eraseTool(updateRoleTool),
  eraseTool(updateAuthMethodsTool),
  eraseTool(updateBrandingTool),
  eraseTool(setupSsoTool),
  eraseTool(addRedirectUriTool),
  eraseTool(removeRedirectUriTool),
  eraseTool(createTenantTool),
  eraseTool(inviteUserTool),
];

/**
 * Register every Bridge tool on an official-SDK McpServer.
 *
 * This is the frozen seam between the tool core and its transport shells
 * (stdio CLI process, hosted Streamable HTTP, ...). The shell owns the server
 * instance, the transport, and how a ToolContext is produced (per-process or
 * per-request via `ctxFactory`); the core owns the tool inventory and the
 * result envelope. ToolResults are serialized as a JSON text content block,
 * with `isError` set on the MCP result for failures.
 */
export function registerBridgeTools(
  server: McpServer,
  ctxFactory: () => ToolContext | Promise<ToolContext>,
): void {
  for (const tool of bridgeTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: z.objectOutputType<z.ZodRawShape, z.ZodTypeAny>) => {
        let result: ToolResult;
        try {
          const ctx = await ctxFactory();
          result = await tool.handler(ctx, args);
        } catch (err) {
          result = {
            success: false,
            error: {
              code: 'UNEXPECTED_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
          ...(result.success ? {} : { isError: true }),
        };
      },
    );
  }
}
