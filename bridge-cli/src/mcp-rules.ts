/**
 * The rule for an app's own MCP endpoint: an MCP server reachable over HTTP sits behind the Bridge guard in MCP mode,
 * so assistants find where to sign in and every call carries a checked user. `bridge check mcp` looks for:
 *
 *   - an MCP endpoint over HTTP: the MCP SDK's server with `StreamableHTTPServerTransport` or `SSEServerTransport`,
 *     or a route named `/mcp` (`app.post('/mcp', …)`, `path: '/mcp'`, a SvelteKit or Next.js `mcp/+server.ts` or
 *     `mcp/route.ts`). A stdio-only server (`StdioServerTransport`) runs on the user's machine and is not one;
 *   - the guard, anywhere in the project: `bridgeMcpGuard` or `bridgeMcpMiddleware` from
 *     `@nebulr-group/bridge-auth-core/server`, or a guard configured with `mode: 'mcp'` (both names are matched while the
 *     SDKs settle on one).
 *
 * An endpoint the developer protects another way stays with a `// bridge-mcp-exception: <reason>` comment in its file.
 * Local and read-only.
 */

export type McpFinding = {
  file: string;
  line: number;
  /** What was found: the transport or the route. */
  text: string;
  /** What to do, in words an agent can act on. */
  instead: string;
};

export const MCP_EXCEPTION_MARKER = 'bridge-mcp-exception';

export const MCP_INSTEAD =
  "Put Bridge's guard in MCP mode in front of the endpoint and its well-known paths: " +
  "`const guard = bridgeMcpGuard({ issuer: process.env.BRIDGE_ISSUER, resource: 'https://<your app>/mcp' })` from " +
  "`@nebulr-group/bridge-auth-core/server`, then `app.use(bridgeMcpMiddleware(guard))` (`/server/node`) or " +
  '`guard.protect(handler)` at the edge. `bridge guide mcp-and-cli` has the steps.';

const SDK_SERVER = /@modelcontextprotocol\/sdk\/server/;
const HTTP_TRANSPORT = /\b(StreamableHTTPServerTransport|SSEServerTransport)\b/;
const MCP_ROUTE = /(?:\.(?:get|post|all|use|route|handle|on)\s*\(\s*|\bpath\s*:\s*|\burl\s*:\s*)['"`]\/mcp(?:\/[^'"`]*)?['"`]/;
/** A file-system route for /mcp: SvelteKit `routes/mcp/+server.ts`, Next.js `app/mcp/route.ts` or `pages/api/mcp.ts`. */
const MCP_ROUTE_FILE = /(?:^|\/)(?:routes|app|pages(?:\/api)?)\/(?:\(.*?\)\/)*mcp(?:\/\+server|\/route|)\.(?:ts|js|mjs)$/;
/** The guard in MCP mode, by its auth-core name or a `mode: 'mcp'` option. */
export const MCP_GUARD = /\bbridgeMcpGuard\b|\bbridgeMcpMiddleware\b|\bmode\s*:\s*['"`]mcp['"`]/;

/** Where a file serves an MCP endpoint over HTTP, or null. */
export function mcpEndpointIn(source: string, file: string): { line: number; text: string } | null {
  if (source.includes(MCP_EXCEPTION_MARKER)) return null;
  const lines = source.split('\n');
  const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
  if (SDK_SERVER.test(source)) {
    const transport = at(HTTP_TRANSPORT);
    if (transport >= 0) return { line: transport + 1, text: (lines[transport] ?? '').trim() };
  }
  const route = at(MCP_ROUTE);
  if (route >= 0) return { line: route + 1, text: (lines[route] ?? '').trim() };
  if (MCP_ROUTE_FILE.test(file.split('\\').join('/'))) return { line: 1, text: `${file}: a route for /mcp` };
  return null;
}

/** Whether a file sets up the guard in MCP mode. */
export function hasMcpGuard(source: string): boolean {
  return MCP_GUARD.test(source);
}

/** The project's MCP endpoints with no Bridge guard: none when any file sets up the guard. */
export function mcpFindings(files: readonly { file: string; source: string }[]): McpFinding[] {
  if (files.some((each) => hasMcpGuard(each.source))) return [];
  return files.flatMap(({ file, source }) => {
    const found = mcpEndpointIn(source, file);
    return found === null ? [] : [{ file, line: found.line, text: found.text, instead: MCP_INSTEAD }];
  });
}
