/**
 * TBP-540 — the orientation map and the seven decision guides exist, carry
 * the facts they exist to carry, and name only tools that exist.
 *
 * Guides are fetched at runtime, not versioned with the code they describe,
 * so a stale one outlives any number of releases: `paymentsAutoRedirect` was
 * "not writable over MCP" in a guide long after `update_app` wrote it. The
 * `bridge …` commands in these files are checked by prompt-commands.test.ts;
 * this file checks the MCP tool names against prompts/mcp-tools.json (copied
 * from bridge-api's tool registry), and the flag attribute contract against
 * auth-core's own attribute provider and operators.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../program';
import { fetchOrientationGuide } from '../commands/guide.command';
import { DECISION_DOMAINS, JOURNEYS, fetchDecisionGuide } from '../commands/journeys';

const PROMPTS = join(__dirname, '..', '..', 'prompts');
const DECISIONS = join(PROMPTS, 'decisions');
const read = (path: string) => readFileSync(path, 'utf-8');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

const guide = (domain: string) => read(join(DECISIONS, `${domain}.md`));

describe('the decision guides', () => {
  it('exist for exactly the seven domains, one file each', () => {
    const files = readdirSync(DECISIONS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    expect(files.sort()).toEqual([...DECISION_DOMAINS].sort());
  });

  it('cover every domain a journey opens with', () => {
    for (const j of JOURNEYS) if (j.domain) expect(DECISION_DOMAINS).toContain(j.domain);
  });

  it.each([...DECISION_DOMAINS])('%s: asks, defaults, acts, proves and connects', (domain) => {
    const text = guide(domain);
    for (const section of ['## Ask the developer', '## Decide yourself', '## Do it', '## Prove it', '## Where this connects']) {
      expect(text).toContain(section);
    }
    // Product questions go to the developer, never guessed.
    expect(text).toMatch(/Ask, wait, never guess/);
    // Every default states its reason in one line.
    const decide = text.split('## Decide yourself')[1].split('\n## ')[0];
    const defaults = decide.split('\n').filter((l) => l.startsWith('- '));
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    // Walks into at least two of the other guides by name.
    const connects = text.split('## Where this connects')[1];
    const others = connects.match(/^- \*\*[^*]+:\*\*/gm) ?? [];
    expect(others.length).toBeGreaterThanOrEqual(2);
  });

  it('read through the same seam the journeys use', async () => {
    for (const domain of DECISION_DOMAINS) {
      await expect(fetchDecisionGuide(domain)).resolves.toBe(guide(domain));
    }
  });

  it('are registered as `bridge guide decision <domain>` and `bridge guide orientation`', () => {
    const program = new Command();
    registerCommands(program);
    const names = program.commands.find((c) => c.name() === 'guide')!.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['decision', 'orientation']));
  });
});

describe('the orientation map', () => {
  it('is bundled and short', async () => {
    const text = await fetchOrientationGuide();
    expect(text).toMatch(/^# What Bridge does/);
    // One short paragraph per area: the relayable part stays under ~25 lines.
    const relay = text.split('\n---\n')[1];
    expect(relay.trim().split('\n').length).toBeLessThanOrEqual(25);
  });

  it('points at every decision guide', async () => {
    const text = await fetchOrientationGuide();
    for (const domain of DECISION_DOMAINS) expect(text).toContain(`bridge guide decision ${domain}`);
  });
});

describe('the payments guide says how a hard limit is enforced end to end', () => {
  const text = guide('payments');
  it.each([
    ['counted once, where the action happens', /It is counted once, where the action happens/],
    ['asks whether the action calls the server', /does the action call your server\?/],
    ['the decorator', /@RequireQuota\('exports'\)/],
    ['the 402 body', /402` with `\{ code: 'QUOTA_EXCEEDED', metric, used, limit, fix \}`/],
    ['one use recorded after 2xx', /After a `2xx` answer, Bridge records one use/],
    ['fail-closed', /503/],
    ['counter vs gauge, in the owner\'s sentence', /If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it\./],
    ['gauges send the app\'s count', /@SyncQuota\('tickets', \{ current \}\)/],
    ['seats are a built-in gauge', /built-in `users` metric, a gauge/],
    ['the upgrade dialog with no code', /upgrade dialog opens on a `402`/],
    ['browser counting is first-class', /complete, first-class way to run limits/],
    ['the paywall needs plans and paymentsAutoRedirect', /only when the app has plans and "customers must pick a plan" is on/],
    ['paymentsAutoRedirect is writable over MCP', /`update_app` \(`paymentsAutoRedirect: false`\)/],
    ['/welcome is offered, not created', /Offer it; create it only if they say yes/],
    ['never pair entitlement and quota', /Never put `@RequireEntitlement` and `@RequireQuota` on the same name/],
  ])('%s', (_name, pattern) => {
    expect(text).toMatch(pattern);
  });
});

/**
 * MCP tool names: backticked snake_case words that start with a tool verb.
 * `QUOTA_EXCEEDED`, `percent_used` or `app_active` are not tools and do not
 * start with one.
 */
const TOOL_VERBS = [
  'add', 'apply', 'clear', 'connect', 'create', 'debug', 'delete', 'diagnose', 'evaluate', 'export', 'get',
  'import', 'invite', 'list', 'remove', 'revoke', 'scaffold', 'set', 'setup', 'toggle', 'update', 'use', 'verify',
];
const TOOL_NAME = new RegExp(`\`((?:${TOOL_VERBS.join('|')})(?:_[a-z]+)+)\``, 'g');

function toolNamesIn(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(TOOL_NAME)].map((m) => m[1]))];
}

describe('MCP tools named in the bundled prompts exist (prompts/mcp-tools.json)', () => {
  const registry = JSON.parse(read(join(PROMPTS, 'mcp-tools.json'))) as { tools: string[] };
  const known = new Set(registry.tools);

  it('the committed list is the registry, not a stub', () => {
    expect(registry.tools.length).toBeGreaterThanOrEqual(60);
    for (const t of registry.tools) expect(t).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });

  const cases = markdownFiles(PROMPTS).flatMap((file) =>
    toolNamesIn(read(file)).map((tool) => [relative(PROMPTS, file), tool] as const),
  );

  it('finds tool names in the decision guides (guards against the extractor matching nothing)', () => {
    const inDecisions = cases.filter(([file]) => file.startsWith('decisions'));
    expect(inDecisions.length).toBeGreaterThan(60);
  });

  it('the extractor catches a tool that does not exist', () => {
    expect(toolNamesIn('call `create_plans` then `QUOTA_EXCEEDED` and `app_active`')).toEqual(['create_plans']);
    expect(known.has('create_plans')).toBe(false);
  });

  it.each(cases)('%s: %s', (_file, tool) => {
    expect(known).toContain(tool);
  });
});

describe('the flag attribute contract in the feature-control guide matches auth-core', () => {
  const text = guide('feature-control');
  const distDir = dirname(require.resolve('@nebulr-group/bridge-auth-core'));
  const providers = jest.requireActual(join(distDir, 'flags/attribute-providers.js'));
  const operators = jest.requireActual(join(distDir, 'flags/operators.js'));

  it('documents every attribute the browser SDKs fill in from the token', () => {
    const auth = new providers.AuthAttributeProvider({
      getClaims: () => ({ sub: 'u1', role: 'ADMIN', email: 'a@b.c', tid: 't1', plan: 'pro', privileges: ['USER_READ'] }),
    });
    const keys = Object.keys(auth.provide());
    expect(keys.sort()).toEqual(['privileges', 'tenant.id', 'tenant.plan', 'user.email', 'user.id', 'user.role']);
    for (const key of keys) expect(text).toContain(`| \`${key}\` |`);
  });

  it('`tenant.plan` is compared ignoring case, as documented', () => {
    expect(text).toMatch(/`tenant\.plan` \| the plan \*\*key\*\*.*\| ignoring case/);
    expect(operators.evaluateCondition({ attribute: 'tenant.plan', operator: 'eq', values: ['Pro'] }, 'pro')).toBe(true);
  });

  it('`user.role` is compared exactly, as documented', () => {
    expect(text).toMatch(/`user\.role` \|.*\| exactly: `admin` does not match `ADMIN`/);
    expect(operators.evaluateCondition({ attribute: 'user.role', operator: 'eq', values: ['admin'] }, 'ADMIN')).toBe(false);
  });

  it('lists exactly the operators auth-core accepts', () => {
    const line = text.split('\n').find((l) => l.startsWith('Operators:'))!;
    const documented = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...operators.OPERATORS].sort());
  });

  it('names the billing attributes under the prefix the provider uses', () => {
    const billing = new providers.BillingAttributeProvider({
      getBillingSnapshot: () => ({ plan: 'pro', trial: true, quota: { exports: { used: 8, limit: 10 } } }),
    });
    const keys = Object.keys(billing.provide());
    expect(keys).toEqual(expect.arrayContaining(['bridge:billing.plan', 'bridge:billing.trial', 'bridge:billing.quota.exports.used']));
    expect(text).toContain('`bridge:billing.plan`');
    expect(text).toContain('`bridge:billing.trial`');
    expect(text).toContain('`bridge:billing.quota.<metric>.used`');
  });
});
