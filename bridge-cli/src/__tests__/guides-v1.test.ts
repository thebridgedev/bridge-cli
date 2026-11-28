/**
 * The 1.0 guides on this line (TBP-292, TBP-356, TBP-812, TBP-831): they name only what CLI 1.0, the new MCP server and
 * the 1.0 plugins have. A guide that names a 0.x setting or API, a `bridge` command or option CLI 1.0 does not have, or
 * an MCP tool the new server does not have, fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCommandLine, commandLines, commandPaths, program } from './helpers/commands';

const PROMPTS = join(__dirname, '..', '..', 'prompts');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const GUIDES = files(PROMPTS).filter((file) => file.endsWith('.md'));
const read = (file: string): string => readFileSync(file, 'utf8');
const name = (file: string): string => relative(PROMPTS, file);

/** 0.x settings and APIs, and wording the rules forbid (TBP-705, E5). */
export const BANNED = [
  'VITE_BRIDGE_APP_ID',
  'VITE_BRIDGE_API_BASE_URL',
  'BRIDGE_API_BASE_URL',
  'VITE_BRIDGE_CALLBACK_URL',
  'PUBLIC_BRIDGE_APP_ID',
  'BRIDGE_APP_ID',
  'bridge app update --ui-url',
  '--ui-url',
  'bridge app redirect-uris',
  '<Entitled',
  'bridge-api',
  'api.thebridge.dev',
  'initBridge',
  'useBridge',
  'display, not enforcement',
  'display only',
  'decoration',
  'the agent verifies',
  '--payments-auto-redirect',
  'FEATURE_NOT_PERMITTED',
  '@CurrentUser',
  '@nebulr-group/bridge-svelte/flags',
  'TeamManagementPanel',
  'bridge.usage.report',
] as const;

const VERIFY_INTRO = 'Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.';

describe('the 1.0 guides name only what 1.0 has', () => {
  it('there are guides to check', () => {
    expect(GUIDES.map(name).sort()).toEqual(
      ['auth-master-integration-prompt.md', 'billing/master.md', 'decisions/feature-control.md', 'decisions/going-live.md', 'decisions/login.md', 'decisions/look-and-feel.md', 'decisions/payments.md', 'decisions/roles.md', 'decisions/teams.md', 'fit-together.md', 'flags/master.md', 'integration-success.md', 'mechanisms.md', 'orientation.md'].sort(),
    );
  });

  it.each(GUIDES.map((file) => [name(file), file]))('%s names no 0.x setting or API and none of the forbidden wording', (_name, file) => {
    const text = read(file);
    expect(BANNED.filter((banned) => text.includes(banned))).toEqual([]);
  });

  it.each(files(PROMPTS).map((file) => [name(file), file]))('%s names nothing internal (the guides are public)', (_name, file) => {
    const text = read(file);
    const internal: [string, RegExp][] = [
      ['an internal ticket id', /\bTBP-\d+/],
      ['an internal milestone', /\bTBP-M\d+/],
      ['an internal service name', /\b(?:bridge-api|bridge-server|cloud-views|admin-ui|nebulr-haga|verdaccio|gitlab)\b/i], // nblocks stays: the guides detect its packages
      ['the owner', /\bthe owner\b/],
    ];
    expect(internal.filter(([, pattern]) => pattern.test(text)).map(([what]) => what)).toEqual([]);
  });

  it.each(GUIDES.map((file) => [name(file), file]))('%s names only CLI 1.0 commands and options', (_name, file) => {
    const root = program();
    const wrong = commandLines(read(file))
      .map((line) => [line, checkCommandLine(line, root)] as const)
      .filter(([, why]) => why !== null)
      .map(([line, why]) => `bridge ${line}: ${why}`);
    expect(wrong).toEqual([]);
  });

  it('the check itself refuses what CLI 1.0 does not have', () => {
    const root = program();
    expect(checkCommandLine('app update --ui-url http://x', root)).toMatch(/--ui-url/);
    expect(checkCommandLine('app redirect-uris add http://x', root)).toMatch(/redirect-uris/);
    expect(checkCommandLine('setup payments --stripe-key sk', root)).toMatch(/payments/);
    expect(checkCommandLine('plan quota set pro --metric x', root)).toMatch(/quota/);
    expect(checkCommandLine('plan entitlement set pro x', root)).toMatch(/entitlement/);
    const sample = ['run `bridge flag get x` then:', '```bash', 'bridge plan create pro \\', '  --name Pro', '```', 'and `npx @nebulr-group/bridge-cli@alpha check gates`.'].join('\n');
    expect(commandLines(sample)).toEqual(['plan create pro --name Pro', 'flag get x', 'check gates']);
    expect(checkCommandLine('app address add https://x --use browser-origin', root)).toBeNull();
    expect(checkCommandLine('plan create pro --name Pro --price "19 EUR/month" --trial-days 14', root)).toBeNull();
    expect(checkCommandLine('auth methods enable|disable <method>', root)).toBeNull();
    expect(checkCommandLine('guide <framework> billing', root)).toBeNull();
    expect(commandPaths(root).map((each) => each.path)).toContain('bridge check gates');
  });

  it('names only MCP tools the new Bridge MCP server has', () => {
    const tools = new Set((JSON.parse(read(join(PROMPTS, 'mcp-tools.json'))) as { tools: string[] }).tools);
    // Snake-case words in code that are not tools: fact names, statuses, operators, metrics.
    const notTools = new Set(['app_active', 'past_due', 'cancel_at_period_end', 'not_contains', 'not_in', 'not_exists', 'ai_completions', 'needs_plan', 'payment_due']);
    const named = new Set(GUIDES.flatMap((file) => [...read(file).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((found) => found[1] as string)));
    expect([...named].filter((word) => !tools.has(word) && !notTools.has(word))).toEqual([]);
  });
});

describe('verify steps split terminal and browser checks (TBP-812)', () => {
  it.each(['billing/master.md', 'flags/master.md', 'auth-master-integration-prompt.md'])('%s has both lists and the Heads up rule', (file) => {
    const text = read(join(PROMPTS, file));
    expect(text).toContain('### Terminal checks');
    expect(text).toContain('### Browser checks');
    expect(text).toContain(VERIFY_INTRO);
    expect(text).toContain('Heads up: not verified in a browser');
    expect(text.indexOf('### Terminal checks')).toBeLessThan(text.indexOf('### Browser checks'));
  });

  it('the terminal checks of billing and flags name CLI 1.0 commands', () => {
    expect(read(join(PROMPTS, 'billing/master.md'))).toEqual(expect.stringContaining('`bridge plan list`'));
    expect(read(join(PROMPTS, 'billing/master.md'))).toEqual(expect.stringContaining('`bridge stripe status`'));
    expect(read(join(PROMPTS, 'flags/master.md'))).toEqual(expect.stringContaining('`bridge flag get <key>`'));
    for (const file of ['billing/master.md', 'flags/master.md']) expect(read(join(PROMPTS, file))).toContain('npx @nebulr-group/bridge-cli@alpha check gates');
  });
});

describe('the look guide (TBP-831)', () => {
  it('points at the SvelteKit look guide and names the tokens', () => {
    const text = read(join(PROMPTS, 'decisions/look-and-feel.md'));
    expect(text).toContain('`bridge guide svelte branding`');
    expect(text).toContain('--bridge-primary');
  });
});

describe('the registries', () => {
  it('guide-coverage.json lists the 1.0 frameworks only, with features the guide command knows', () => {
    const coverage = JSON.parse(read(join(PROMPTS, 'guide-coverage.json'))) as { frameworks: Record<string, string[]>; noPluginYet: string[] };
    expect(Object.keys(coverage.frameworks).sort()).toEqual(['javascript', 'nestjs', 'svelte']);
    expect(coverage.noPluginYet.sort()).toEqual(['angular', 'express', 'nextjs', 'react']);
    const known = ['integration', 'auth', 'sdk-auth', 'feature-flags', 'billing', 'team', 'branding', 'server'];
    for (const features of Object.values(coverage.frameworks)) for (const feature of features) expect(known).toContain(feature);
  });

  it('every product decision is named in its decision guide', () => {
    const { decisions } = JSON.parse(read(join(PROMPTS, 'product-decisions.json'))) as { decisions: { tool: string; field: string; guide: string }[] };
    for (const decision of decisions) {
      const guide = read(join(PROMPTS, 'decisions', `${decision.guide}.md`));
      expect(guide).toContain(`\`${decision.tool}\``);
      expect(guide).toContain(`\`${decision.field}\``);
    }
  });
});
