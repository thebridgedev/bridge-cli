/**
 * The integration guides are read from Bridge's public repositories, the way the assistant reads them. CLI 1.0 reads the
 * 1.0 line (`v1`) and never the 0.x text on `main` (TBP-356).
 */
import { createFakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

const FILES: Record<string, string> = {
  'bridge-cli/v1/bridge-cli/prompts/auth-master-integration-prompt.md': '# Master',
  'bridge-cli/v1/bridge-cli/prompts/decisions/payments.md': '# Decide payments',
  'bridge-cli/v1/bridge-cli/prompts/billing/master.md': '# Billing master',
  'bridge-cli/v1/bridge-cli/prompts/flags/master.md': '# Flags master',
  'bridge-cli/v1/bridge-cli/prompts/mechanisms.md': '# Mechanisms',
  'bridge-cli/v1/bridge-cli/prompts/guide-coverage.json': JSON.stringify({ frameworks: { svelte: ['sdk-auth', 'billing'] } }),
  'bridge-svelte/v1/mcp/billing-prompt.md': '# Svelte billing',
  'bridge-svelte/v1/mcp/sdk-auth-prompt.md': '# Svelte auth',
  'bridge-svelte/v1/mcp/branding-prompt.md': '# Svelte look',
  'bridge-nestjs/v1/mcp/auth-prompt.md': '# Nest auth',
  'bridge-nestjs/v1/mcp/feature-flags-prompt.md': '# Nest flags',
  'auth-core/v1/mcp/integration-prompt.md': '# Core integration',
  'auth-core/v1/mcp/server-prompt.md': '# Core server',
  // The 0.x line: never read by CLI 1.0, even where v1 has no such file.
  'bridge-cli/main/bridge-cli/prompts/decisions/login.md': '# 0.x login',
  'bridge-svelte/main/mcp/team-prompt.md': '# 0.x Svelte team',
  'bridge-react/main/mcp/integration-prompt.md': '# 0.x React',
};
const requested: string[] = [];
const serve = (base: string) => async (url: string): Promise<Response> => {
  requested.push(url);
  const body = url.startsWith(`${base}/`) ? FILES[url.slice(base.length + 1)] : undefined;
  return body === undefined ? new Response('404: Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }) : new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
const fetchGuides = serve('https://raw.githubusercontent.com/thebridgedev');

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
    expect((await cli.run(['guide', 'flags'], { fetch: fetchGuides })).texts).toEqual(['# Flags master']);
    expect((await cli.run(['guide', 'billing', '--framework', 'svelte'], { fetch: fetchGuides })).texts).toEqual(['# Svelte billing']);
    expect((await cli.run(['guide', 'svelte', 'auth'], { fetch: fetchGuides })).texts).toEqual(['# Svelte auth']);
    expect((await cli.run(['guide', 'svelte', 'branding'], { fetch: fetchGuides })).texts).toEqual(['# Svelte look']);
    expect((await cli.run(['guide', 'mechanisms', '--json'], { fetch: fetchGuides })).data).toEqual({ topic: 'mechanisms', markdown: '# Mechanisms' });
  });

  it('reads every guide from the 1.0 line, and never from main', async () => {
    await cli.run(['guide'], { fetch: fetchGuides });
    await cli.run(['guide', 'svelte', 'auth'], { fetch: fetchGuides });
    await cli.run(['guide', 'nestjs', 'auth'], { fetch: fetchGuides });
    await cli.run(['guide', 'flags', '--framework', 'nestjs'], { fetch: fetchGuides });
    expect(requested).toEqual([
      'https://raw.githubusercontent.com/thebridgedev/bridge-cli/v1/bridge-cli/prompts/auth-master-integration-prompt.md',
      'https://raw.githubusercontent.com/thebridgedev/bridge-svelte/v1/mcp/sdk-auth-prompt.md',
      // nestjs has no sdk-auth guide: the next file of the feature, still on v1
      'https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/v1/mcp/sdk-auth-prompt.md',
      'https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/v1/mcp/auth-prompt.md',
      'https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/v1/mcp/feature-flags-prompt.md',
    ]);
  });

  it('a guide missing on the 1.0 line is missing: the 0.x text is never served in its place', async () => {
    expect((await cli.run(['guide', 'svelte', 'team'], { fetch: fetchGuides })).error).toMatchObject({ code: 'not-found' });
    const login = (await cli.run(['guide', 'decision', 'login'], { fetch: fetchGuides })).texts[0] as string;
    expect(login).not.toContain('0.x');
    expect(requested.some((url) => url.includes('/main/'))).toBe(false);
  });

  it('auth-core is the javascript framework: its integration and server guides', async () => {
    expect((await cli.run(['guide', 'javascript'], { fetch: fetchGuides })).texts).toEqual(['# Core integration']);
    expect((await cli.run(['guide', 'javascript', 'server'], { fetch: fetchGuides })).texts).toEqual(['# Core server']);
    expect(requested).toEqual(['https://raw.githubusercontent.com/thebridgedev/auth-core/v1/mcp/integration-prompt.md', 'https://raw.githubusercontent.com/thebridgedev/auth-core/v1/mcp/server-prompt.md']);
  });

  it.each(['react', 'nextjs', 'angular', 'express'])('%s has no 1.0 plugin: a plain note, never its 0.x guide', async (framework) => {
    const run = await cli.run(['guide', framework], { fetch: fetchGuides });
    expect(run.exitCode).toBe(0);
    expect(run.texts[0]).toContain(`${framework} has no 1.0 plugin yet`);
    expect(run.texts[0]).toContain('bridge guide javascript');
    expect((await cli.run(['guide', 'billing', '--framework', framework], { fetch: fetchGuides })).texts[0]).toContain('no 1.0 plugin yet');
    expect(requested).toEqual([]);
  });

  it('BRIDGE_GUIDES_BASE_URL reads the guides from another place, laid out the same way', async () => {
    const local = 'http://127.0.0.1:4599/guides';
    expect((await cli.run(['guide', 'svelte', 'billing'], { fetch: serve(local), env: { BRIDGE_GUIDES_BASE_URL: `${local}/` } })).texts).toEqual(['# Svelte billing']);
    expect(requested).toEqual([`${local}/bridge-svelte/v1/mcp/billing-prompt.md`]);
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

  it.each(['add-paid-plan', 'add-feature-flag'])('%s splits its checks into terminal and browser ones, with the Heads up rule (TBP-812)', async (journey) => {
    const text = (await cli.run(['guide', journey], { fetch: fetchGuides })).texts[0] as string;
    expect(text).toContain('Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered');
    expect(text).toContain('Terminal checks:');
    expect(text).toContain('Browser checks: 1.');
    expect(text).toContain('Heads up: not verified in a browser');
    expect(text).toContain('check gates');
    expect(text).not.toContain('Social sign-in and MFA are not available');
  });

  it('verify-setup lists terminal checks with CLI 1.0 commands', async () => {
    const text = (await cli.run(['guide', 'verify-setup'], { fetch: fetchGuides })).texts[0] as string;
    expect(text).toContain('Terminal checks:');
    expect(text).toContain('`bridge doctor`');
    expect(text).toContain('`bridge setup status`');
  });

  it('says what is missing, and what to do when the network is', async () => {
    expect((await cli.run(['guide', 'cobol'], { fetch: fetchGuides })).errors).not.toEqual([]);
    const offline = await cli.run(['guide'], { fetch: async () => Promise.reject(new TypeError('offline')) });
    expect(offline.error).toMatchObject({ code: 'network' });
  });

  it('list shows the journeys, the decisions, the coverage and the frameworks with no 1.0 plugin', async () => {
    const listed = (await cli.run(['guide', 'list'], { fetch: fetchGuides })).data;
    expect(listed.journeys).toEqual(['add-login', 'add-paid-plan', 'add-feature-flag', 'add-teams', 'go-live', 'verify-setup', 'whats-wrong']);
    expect(listed.frameworks).toEqual({ svelte: ['sdk-auth', 'billing'] });
    expect(listed.noPluginYet).toEqual(['react', 'angular', 'nextjs', 'express']);
    expect(requested).toEqual(['https://raw.githubusercontent.com/thebridgedev/bridge-cli/v1/bridge-cli/prompts/guide-coverage.json']);
  });
});
