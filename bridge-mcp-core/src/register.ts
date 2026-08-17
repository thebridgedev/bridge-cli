import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { AnyBridgeToolDefinition, ToolContext, ToolResult } from './types.js';
import { getAppTool } from './tools/app.js';
import { listFeatureFlagsTool } from './tools/flags.js';
import { listPlansTool } from './tools/plans.js';
import { listRolesTool } from './tools/roles.js';
import { getAuthConfigTool } from './tools/auth-config.js';
import { getEnvironmentInfoTool } from './tools/environment.js';

/**
 * The Bridge tool registry. Transport shells never enumerate tools
 * themselves — they call `registerBridgeTools` and get whatever this array
 * contains. Adding a tool to the platform means adding it here.
 */
export const bridgeTools: AnyBridgeToolDefinition[] = [
  getAppTool,
  listFeatureFlagsTool,
  listPlansTool,
  listRolesTool,
  getAuthConfigTool,
  getEnvironmentInfoTool,
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
