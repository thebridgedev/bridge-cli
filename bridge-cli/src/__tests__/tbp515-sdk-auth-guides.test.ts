/**
 * TBP-515 — the in-app sign-in guides are advertised for every frontend, and
 * the CLI's own text matches what the ports shipped.
 *
 * bridge-react (PR #39) and bridge-angular (PR #29/#30) now ship
 * `mcp/sdk-auth-prompt.md` like svelte and nextjs. `bridge guide <fw> sdk-auth`
 * must fetch that file from the plugin repo, `bridge guide list` must name it,
 * and the master prompt must name each framework's one auth route. On the
 * backend, bridge-express 0.7 (PR #14) removed `protect({ role | plans |
 * entitlement })` and added `requireQuota` / `syncQuota` / `requireEntitlement`;
 * `bridge check gates` and the guide currency rules must know both.
 *
 * `fetch` (GitHub) is the only fake.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputPrompt: jest.fn(), outputError: jest.fn() }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../program';
import { outputError, outputPrompt, outputSuccess } from '../output.js';
import { codeGateFindings, docGateViolations } from '../gate-rules';
import { pluginGuideUrl } from '../prompt-urls';

const PROMPTS = join(__dirname, '..', '..', 'prompts');
const prompt = (name: string) => readFileSync(join(PROMPTS, name), 'utf-8');

const realFetch = global.fetch;
let fetched: string[];

beforeEach(() => {
  delete process.env.BRIDGE_GUIDE_LOCAL_DIR;
  fetched = [];
  (outputPrompt as jest.Mock).mockReset();
  (outputSuccess as jest.Mock).mockReset();
  (outputError as jest.Mock).mockReset();
  global.fetch = jest.fn(async (url: string) => {
    fetched.push(String(url));
    const m = /\/(bridge-\w+)\/main\/mcp\/sdk-auth-prompt\.md$/.exec(String(url));
    return (m
      ? { ok: true, status: 200, text: async () => `# ${m[1]} SDK auth` }
      : { ok: false, status: 404, text: async () => '' }) as unknown as Response;
  }) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerCommands(program);
  await program.parseAsync(['node', 'bridge', ...args]);
}

describe('`bridge guide <frontend> sdk-auth`', () => {
  it.each(['react', 'angular', 'nextjs', 'svelte'])('%s fetches the plugin repo guide and prints it', async (fw) => {
    await run('guide', fw, 'sdk-auth');
    expect(outputError).not.toHaveBeenCalled();
    expect(fetched).toEqual([pluginGuideUrl(`bridge-${fw}/main`, 'sdk-auth-prompt.md')]);
    expect(outputPrompt).toHaveBeenCalledWith(`# bridge-${fw} SDK auth`);
  });

  it('`bridge guide list` advertises it for every frontend and no backend', async () => {
    await run('guide', 'list');
    const { features } = (outputSuccess as jest.Mock).mock.calls[0][0] as { features: Record<string, string[]> };
    for (const fw of ['svelte', 'react', 'angular', 'nextjs']) expect(features[fw]).toContain('sdk-auth');
    for (const fw of ['nestjs', 'express']) expect(features[fw]).not.toContain('sdk-auth');
  });
});

describe('the master prompt names each frontend one auth route', () => {
  const master = prompt('auth-master-integration-prompt.md');

  it.each(['react', 'nextjs', 'angular'])('offers `bridge guide %s sdk-auth`', (fw) => {
    expect(master).toContain(`\`bridge guide ${fw} sdk-auth\``);
  });

  it('names the route shapes the ports shipped, not "the guide names the files"', () => {
    expect(master).not.toMatch(/On other frameworks the guide names the files/);
    expect(master).toContain('`<BridgeAuthRoutes />`');
    expect(master).toContain('`app/auth/[...bridge]/page.tsx`');
    expect(master).toContain('`...bridgeAuthRoutes()`');
    expect(master).toContain('`...bridgeBillingRoutes()`');
  });

  it('says an explicit option wins over the environment, with every env name', () => {
    expect(master).toMatch(/option passed explicitly wins over the environment/);
    for (const env of ['VITE_BRIDGE_APP_ID', 'NEXT_PUBLIC_BRIDGE_APP_ID', 'BRIDGE_APP_ID']) expect(master).toContain(env);
  });
});

describe('Express after bridge-express 0.7 (PR #14)', () => {
  it.each([
    ["app.get('/admin', bridge.protect({ role: 'ADMIN' }), handler);", 'removed-api'],
    ["app.get('/x', bridge.protect({ entitlement: 'analytics' }), handler);", 'removed-api'],
    ["app.get('/x', bridge.protect({ entitlements: ['analytics'] }), handler);", 'removed-api'],
    ["app.get('/x', bridge.protect({ plans: ['pro'] }), handler);", 'removed-api'],
    ["app.get('/x', bridge.requireEntitlement('analytics'), handler);", 'plan-feature'],
  ])('`bridge check gates` flags %s', (line, kind) => {
    const [finding] = codeGateFindings(line, 'src/app.ts');
    expect(finding?.kind).toBe(kind);
    expect(finding.instead).toMatch(/featureFlag|flag ruled|bridge:billing\.entitlement/);
  });

  it('leaves the gates that remain alone', () => {
    for (const line of [
      "app.get('/beta', bridge.protect({ featureFlag: 'new-home' }), handler);",
      "app.post('/exports', bridge.requireQuota('exports'), handler);",
      "app.delete('/tickets/:id', bridge.syncQuota('tickets', { current }), handler);",
      "app.get('/tokens', bridge.protect({ privilege: 'USER_READ' }), handler);",
    ]) {
      expect(codeGateFindings(line, 'src/app.ts')).toEqual([]);
    }
  });

  it('no guide may teach the removed options or a direct requireEntitlement', () => {
    expect(docGateViolations("Use `bridge.protect({ role: 'ADMIN' })` on the route.")).toHaveLength(1);
    expect(docGateViolations("Add `bridge.requireEntitlement('analytics')` to the route.")).toHaveLength(1);
  });

  it('the bundled guides name the Express limit middleware', () => {
    expect(prompt('billing/master.md')).toContain('bridge.requireQuota');
    expect(prompt('decisions/payments.md')).toContain("bridge.requireQuota('exports')");
    expect(prompt('fit-together.md')).toContain("bridge.requireQuota('exports')");
    expect(prompt('mechanisms.md')).toContain('`bridge guide express billing`');
  });
});
