/**
 * `bridge check mcp`: an MCP endpoint over HTTP with no Bridge guard in MCP mode is listed with what to do, and the
 * command exits 1; the guard anywhere in the project (`bridgeMcpGuard`, `bridgeMcpMiddleware` or `mode: 'mcp'`), a
 * stdio-only server or the exception comment keeps it quiet.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkMcp, formatMcpReport } from '../commands/check.command';
import { mcpEndpointIn } from '../mcp-rules';
import { buildProgram } from '../program';

let root: string;
const write = (path: string, body: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

const SERVER = [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
  'const server = new McpServer({ name: "acme", version: "1.0.0" });',
  "app.post('/mcp', async (req, res) => {",
  '  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });',
  '  await server.connect(transport);',
  '});',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-mcp-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bridge check mcp', () => {
  it('is a registered command', () => {
    const program = buildProgram({ fetch: async () => new Response(null), env: {}, io: {} as never, openBrowser: async () => ({ ok: false }) });
    expect(program.commands.find((c) => c.name() === 'check')!.commands.map((c) => c.name())).toContain('mcp');
  });

  it('lists an MCP SDK endpoint over HTTP with no guard, with what to do', () => {
    write('src/server.ts', SERVER);
    const { scanned, findings } = checkMcp(root);
    expect(scanned).toBe(1);
    expect(findings).toEqual([{ file: 'src/server.ts', line: 2, text: expect.stringContaining('StreamableHTTPServerTransport'), instead: expect.stringContaining('bridgeMcpGuard') }]);
    expect(formatMcpReport(scanned, findings)).toContain('src/server.ts:2  MCP endpoint');
  });

  it('finds the older SSE transport, a /mcp route and a file-system route for /mcp', () => {
    expect(mcpEndpointIn("import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\nnew SSEServerTransport('/messages', res);", 'a.ts')?.line).toBe(1);
    expect(mcpEndpointIn("router.all('/mcp', handler);", 'b.ts')).toEqual({ line: 1, text: "router.all('/mcp', handler);" });
    expect(mcpEndpointIn("const routes = [{ path: '/mcp/messages', handler }];", 'c.ts')?.line).toBe(1);
    expect(mcpEndpointIn('export const POST = handler;', 'src/routes/mcp/+server.ts')).not.toBeNull();
    expect(mcpEndpointIn('export const POST = handler;', 'app/(api)/mcp/route.ts')).not.toBeNull();
    // Not an MCP endpoint: a stdio server runs on the user's machine; a route that only starts with /mcp is another route.
    expect(mcpEndpointIn("import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nnew StdioServerTransport();", 'd.ts')).toBeNull();
    expect(mcpEndpointIn("app.get('/mcpx', handler);", 'e.ts')).toBeNull();
    expect(mcpEndpointIn('export const GET = handler;', 'src/routes/mcp-docs/+page.ts')).toBeNull();
  });

  it.each([
    ['bridgeMcpGuard', "import { bridgeMcpGuard } from '@nebulr-group/bridge-auth-core/server';\nexport const guard = bridgeMcpGuard({ issuer, resource: 'https://acme.example/mcp' });"],
    ['bridgeMcpMiddleware', "import { bridgeMcpMiddleware } from '@nebulr-group/bridge-auth-core/server/node';\napp.use(bridgeMcpMiddleware(guard));"],
    ["mode: 'mcp'", "export const guard = createBridgeServer({ issuer, mode: 'mcp', resource });"],
  ])('is quiet once the project has the guard (%s), in any file', (_name, guard) => {
    write('src/server.ts', SERVER);
    write('src/bridge.ts', guard);
    expect(checkMcp(root).findings).toEqual([]);
  });

  it('keeps an endpoint marked as protected another way, and exits 1 while one is left', async () => {
    write('src/other.ts', `// bridge-mcp-exception: behind our own gateway\n${SERVER}`);
    expect(checkMcp(root).findings).toEqual([]);
    write('src/server.ts', SERVER);
    let exitCode = 0;
    const texts: string[] = [];
    const io = { text: (t: string) => texts.push(t), result: () => {}, info: () => {}, error: (e: unknown) => { throw e; }, setExitCode: (code: number) => (exitCode = code) } as never;
    const program = buildProgram({ fetch: async () => new Response(null), env: {}, io, openBrowser: async () => ({ ok: false }) });
    await program.parseAsync(['node', 'bridge', 'check', 'mcp', '--cwd', root]);
    expect(exitCode).toBe(1);
    expect(texts.join('')).toContain('1 MCP endpoint without Bridge\'s guard');
  });
});
