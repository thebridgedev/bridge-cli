import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bridgeTools, getAppTool, registerBridgeTools } from '../index.js';
import type { ToolContext } from '../index.js';

const APP = { id: 'app_123', name: 'Test App', defaultRole: 'USER' };

function mockContext() {
  const get = jest.fn().mockResolvedValue(APP);
  const ctx = { management: { app: { get } } } as unknown as ToolContext;
  return { ctx, get };
}

describe('bridge-mcp-core seam', () => {
  it('registry contains get_app', () => {
    expect(bridgeTools.map((t) => t.name)).toContain('get_app');
  });

  it('get_app handler returns {success:true, data} with a mocked management client', async () => {
    const { ctx, get } = mockContext();
    const result = await getAppTool.handler(ctx, {});
    expect(result).toEqual({ success: true, data: APP });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('registerBridgeTools registers get_app on a real McpServer', async () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    const { ctx } = mockContext();
    registerBridgeTools(server, () => ctx);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('get_app');

      const res = await client.callTool({ name: 'get_app', arguments: {} });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe('text');
      expect(JSON.parse(content[0].text)).toEqual({ success: true, data: APP });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a throwing handler surfaces as isError with the failure envelope', async () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    const failingCtx = {
      management: {
        app: { get: jest.fn().mockRejectedValue(new Error('boom')) },
      },
    } as unknown as ToolContext;
    registerBridgeTools(server, () => failingCtx);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const res = await client.callTool({ name: 'get_app', arguments: {} });
      expect(res.isError).toBe(true);
      const content = res.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({
        success: false,
        error: { code: 'UNEXPECTED_ERROR', message: 'boom' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
