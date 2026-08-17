import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBridgeTools } from '@nebulr-group/bridge-mcp-core';
import type { ToolContext } from '@nebulr-group/bridge-mcp-core';
import { getManagementClient } from '../config.js';
import { outputError } from '../output.js';

/**
 * `bridge mcp` — stdio MCP server exposing the Bridge tool core.
 *
 * IMPORTANT: once the transport is connected, stdout belongs to the MCP
 * protocol. Nothing in this command may write to stdout — banners, status and
 * errors all go to stderr (`outputError` already writes to stderr).
 *
 * Credentials resolve exactly like every other CLI command (see config.ts):
 * `bridge auth login` credentials file first, then BRIDGE_API_KEY /
 * BRIDGE_BASE_URL env vars. We resolve the client eagerly so a missing login
 * fails fast at startup with an actionable message in the MCP client's log,
 * instead of every tool call failing later.
 */
export function registerMcpCommands(program: Command, version = '0.0.0'): void {
  program
    .command('mcp')
    .description(
      'Start a Model Context Protocol server on stdio exposing Bridge read tools. ' +
        'Point an MCP client (Claude Code, Cursor, ...) at `bridge mcp`. Uses the same ' +
        'credentials as the rest of the CLI (`bridge auth login` or BRIDGE_API_KEY).',
    )
    .action(async () => {
      try {
        // Fail fast on missing/expired credentials. getManagementClient()
        // caches the instance, so the per-call factory below reuses it.
        getManagementClient();
      } catch (err) {
        outputError(err);
        return;
      }

      const server = new McpServer({ name: 'bridge', version });
      // The cast bridges a nominal (not structural) mismatch: when npm nests a
      // second copy of @nebulr-group/bridge-auth-core under bridge-mcp-core,
      // BridgeManagement's private fields make the two identical declarations
      // incompatible. mcp-core's tools duck-type the client, so this is safe.
      registerBridgeTools(
        server,
        () => ({ management: getManagementClient() }) as unknown as ToolContext,
      );

      const transport = new StdioServerTransport();
      await server.connect(transport);
      // stderr only — stdout is the protocol channel.
      process.stderr.write(`bridge mcp: MCP server ready on stdio (bridge-cli v${version})\n`);
    });
}
