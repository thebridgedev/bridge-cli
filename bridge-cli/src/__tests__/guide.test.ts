/** The integration guides are read from Bridge's public repositories, the way the assistant reads them. */
import { createFakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

const FILES: Record<string, string> = {
  'bridge-cli/main/bridge-cli/prompts/auth-master-integration-prompt.md': '# Master',
  'bridge-cli/main/bridge-cli/prompts/decisions/payments.md': '# Decide payments',
  'bridge-cli/main/bridge-cli/prompts/billing/master.md': '# Billing master',
  'bridge-cli/main/bridge-cli/prompts/mechanisms.md': '# Mechanisms',
  'bridge-cli/main/bridge-cli/prompts/guide-coverage.json': JSON.stringify({ frameworks: { svelte: ['auth', 'billing'] } }),
  'bridge-svelte/main/mcp/billing-prompt.md': '# Svelte billing',
  'bridge-svelte/main/mcp/sdk-auth-prompt.md': '# Svelte auth',
};
const requested: string[] = [];
const fetchGuides = async (url: string): Promise<Response> => {
  requested.push(url);
  const body = FILES[url.replace('https://raw.githubusercontent.com/thebridgedev/', '')];
  return body === undefined ? new Response('404: Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }) : new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

const fake = createFakeBridge();
const cli = createCli(fake);
afterAll(() => cli.cleanup());
beforeEach(() => {
  requested.length = 0;
});

describe('bridge guide', () => {
  it('prints the master prompt with no arguments, and the guides by name, as markdown or a JSON envelope', async () => {
    expect((await cli.run(['guide'], { fetch: fetchGuides })).texts).toEqual(['# Master']);
    expect((await cli.run(['guide', 'mechanisms'], { fetch: fetchGuides })).texts).toEqual(['# Mechanisms']);
    expect((await cli.run(['guide', 'billing'], { fetch: fetchGuides })).texts).toEqual(['# Billing master']);
    expect((await cli.run(['guide', 'billing', '--framework', 'svelte'], { fetch: fetchGuides })).texts).toEqual(['# Svelte billing']);
    expect((await cli.run(['guide', 'svelte', 'auth'], { fetch: fetchGuides })).texts).toEqual(['# Svelte auth']);
    expect((await cli.run(['guide', 'mechanisms', '--json'], { fetch: fetchGuides })).data).toEqual({ topic: 'mechanisms', markdown: '# Mechanisms' });
    expect(requested.every((url) => url.startsWith('https://raw.githubusercontent.com/thebridgedev/'))).toBe(true);
  });

  it('decision guides, with the closest master while one is not written', async () => {
    expect((await cli.run(['guide', 'decision', 'payments'], { fetch: fetchGuides })).texts).toEqual(['# Decide payments']);
    const unwritten = (await cli.run(['guide', 'decision', 'login'], { fetch: fetchGuides })).texts[0] as string;
    expect(unwritten).toContain('not written yet');
    expect(unwritten).toContain('# Master');
    expect((await cli.run(['guide', 'decision', 'nonsense'], { fetch: fetchGuides })).error).toMatchObject({ code: 'invalid' });
  });

  it('a journey gives its steps, its decision guide and the framework guide', async () => {
    const text = (await cli.run(['guide', 'add-paid-plan', '--framework', 'svelte'], { fetch: fetchGuides })).texts[0] as string;
    expect(text).toContain('# add-paid-plan — a Bridge journey');
    expect(text).toContain('## Decision guide: payments');
    expect(text).toContain('# Decide payments');
    expect(text).toContain('## svelte billing guide');
    expect(text).toContain('Product questions');
  });

  it('says what is missing, and what to do when the network is', async () => {
    expect((await cli.run(['guide', 'svelte', 'team'], { fetch: fetchGuides })).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['guide', 'cobol'], { fetch: fetchGuides })).errors).not.toEqual([]);
    const offline = await cli.run(['guide'], { fetch: async () => Promise.reject(new TypeError('offline')) });
    expect(offline.error).toMatchObject({ code: 'network' });
  });

  it('list shows the journeys, the decisions and the coverage', async () => {
    const listed = (await cli.run(['guide', 'list'], { fetch: fetchGuides })).data;
    expect(listed.journeys).toEqual(['add-login', 'add-paid-plan', 'add-feature-flag', 'add-teams', 'go-live', 'verify-setup', 'whats-wrong']);
    expect(listed.frameworks).toEqual({ svelte: ['auth', 'billing'] });
  });
});

describe('bridge guide mcp-and-cli', () => {
  const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { docGateViolations } = jest.requireActual<typeof import('../gate-rules')>('../gate-rules');
  const guide = readFileSync(join(__dirname, '..', '..', 'prompts', 'mcp-and-cli.md'), 'utf8');

  it('reads the guide from the prompts, as the other guides', async () => {
    const files = { ...FILES, 'bridge-cli/main/bridge-cli/prompts/mcp-and-cli.md': guide };
    const fetchIt = async (url: string) => {
      const body = (files as Record<string, string>)[url.replace('https://raw.githubusercontent.com/thebridgedev/', '')];
      return body === undefined ? new Response('404', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    expect((await cli.run(['guide', 'mcp-and-cli'], { fetch: fetchIt })).texts).toEqual([guide]);
  });

  it("points at auth-core's MCP mode and CLI helper, and teaches no direct gate", () => {
    for (const name of ['bridgeMcpGuard', 'bridgeMcpMiddleware', 'createBridgeCli', 'bridge check mcp', 'bridge app mcp add']) expect(guide).toContain(name);
    expect(docGateViolations(guide)).toEqual([]);
  });
});
