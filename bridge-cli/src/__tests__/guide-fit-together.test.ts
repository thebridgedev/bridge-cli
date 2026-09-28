/**
 * TBP-705 — "How roles, plans, limits and flags fit together": the one guide
 * every decision guide and the orientation point to, and the currency check
 * that keeps every bundled guide on the owner's rule (2026-09-28).
 *
 * Why the check exists: the owner's first real run (TBP-543 friction log) had
 * an agent tell him admin-only needs "a role check on the page" and offer
 * browser counting as "demo-grade". Both came from guide text. A guide that
 * teaches a hard-coded role or plan-name check, or talks browser counting
 * down, now fails here.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../program';
import { fetchFitTogetherGuide, loadGuideCoverage } from '../commands/guide.command';
import { DECISION_DOMAINS, JOURNEYS } from '../commands/journeys';

const PROMPTS = join(__dirname, '..', '..', 'prompts');
const read = (path: string) => readFileSync(path, 'utf-8');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** The owner's best-practice sentence, verbatim from the TBP-705 note "Owner decisions 2026-09-28". */
const OWNER_RULE =
  'Features should be controlled with feature flags. A flag can switch a route, an API endpoint, a feature or a ' +
  "single piece of code; its rules change without a release and update live when someone's role or plan changes. " +
  'If a plan sells the feature, include it on the plan as well. This is valuable because the plan is where the ' +
  'customer sees what they are buying: the pricing table, the upgrade dialog and the "not on your plan" reason all ' +
  "read the plan's list, and the flag's rule points at that same list, so changing what Pro includes is one edit " +
  'in one place.';

describe('bridge guide fit-together', () => {
  it('is a registered guide command', () => {
    const program = new Command();
    registerCommands(program);
    const guide = program.commands.find((c) => c.name() === 'guide')!;
    expect(guide.commands.map((c) => c.name())).toContain('fit-together');
  });

  it('prints the bundled page, which states the owner rule verbatim', async () => {
    const page = await fetchFitTogetherGuide();
    expect(page).toMatch(/^# How roles, plans, limits and flags fit together/);
    expect(page).toContain(OWNER_RULE);
  });

  it('is listed in guide-coverage.json topics', () => {
    expect(Object.keys(loadGuideCoverage().topics)).toEqual(
      expect.arrayContaining(['orientation', 'fit-together', 'mechanisms']),
    );
  });

  describe('carries each part of the rule', () => {
    let page: string;
    beforeAll(async () => {
      page = await fetchFitTogetherGuide();
    });

    it.each([
      ['a plan feature rule points at the plan list', /bridge:billing\.entitlement\.analytics eq true/],
      ['the rule never names plans', /The flag's rule never names plans/],
      ['numbers are plan limits', /Numbers are plan limits/],
      ['one record stays in app code', /Permission on one specific record stays in app code/],
      ['a plan-feature check without a flag is the exception', /Checking a plan feature without a flag is the exception/],
      ['privilege preferred over role', /Prefer a privilege rule/],
      ['never a hard-coded role check', /never with a role check written into the app's code/],
      ['roles are the default setup only', /only ever "in the default setup"/],
      ['read list_roles first', /`list_roles` \/ `bridge role list` before writing any rule/],
      ['the agent asks where the action happens', /\*\*"Does this action call your server\?"\*\*/],
      ['browser counting is first-class, trusting the browser, said once', /first-class way to run limits\. It trusts the browser/],
      ['never counted twice', /Never count one metric in both places/],
      ['no dialog opens by itself', /No upgrade dialog opens by itself/],
    ])('%s', (_name, pattern) => {
      expect(page).toMatch(pattern);
    });

    it('says "trusts the browser" once', () => {
      expect(page.match(/trusts the browser/g)).toHaveLength(1);
    });
  });

  it('every decision guide, the orientation and the mechanisms page point to it', () => {
    const files = [
      ...DECISION_DOMAINS.map((d) => join(PROMPTS, 'decisions', `${d}.md`)),
      join(PROMPTS, 'orientation.md'),
      join(PROMPTS, 'mechanisms.md'),
    ];
    for (const file of files) expect([relative(PROMPTS, file), read(file).includes('bridge guide fit-together')]).toEqual([relative(PROMPTS, file), true]);
  });
});

// ── The access-rule currency check ──────────────────────────────────────────

/**
 * Sentences a guide must never contain: telling an agent to control a feature
 * with a hard-coded role or plan-name check, a flag rule that names plans, or
 * calling browser counting demo-grade / not working. A sentence that says
 * NOT to do it ("never a role check…", "instead of naming plans") is allowed.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['a role compared in code', /\b(?:user|session|claims|token|me|currentUser|locals\.user|req\.user)\??\.role\s*(?:===|!==|==|!=)/],
  ['a role compared in code', /\brole\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a role checked in code', /\bhasRole\s*\(/],
  ['a role decorator on a handler', /@RequireRole\s*\(/],
  ['a role check on the page', /\brole check\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|handler|layout|controller)/i],
  ['a role check on the page', /\bcheck\w*\b[^.\n]{0,30}\brole\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|layout)\b/i],
  ['"target a role instead"', /target a role instead/i],
  ['a plan name compared in code', /\.plan(?:Key|Name)?\s*(?:===|!==|==|!=)\s*['"`]/],
  ['a plan name compared in code', /\bplan(?:Key|Name)?\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a plan-name helper', /\bis(?:Pro|Free|Enterprise|Team|Business)(?:Plan|User)?\b\s*[(=]/],
  ['a flag rule that names plans', /"attribute"\s*:\s*"(?:tenant\.plan|bridge:billing\.plan)"/],
  ['browser counting called demo-grade', /demo[- ]grade/i],
  [
    'browser counting said not to work',
    /\b(?:browser|frontend|client)(?:[- ](?:only|side))?\b[^.\n]{0,40}\b(?:won't|will not|does not|doesn't|cannot|can't|can not) (?:work|enforce|be trusted)/i,
  ],
  // TBP-757: `contains` on privileges is exact membership; advice written around the old substring match is stale.
  ['privileges said to match as text', /\b(?:matched|matches|match) (?:privilege keys )?as text\b|\bno other (?:privilege )?key contains\b/i],
  ['browser counting said not production-ready', /\b(?:browser|frontend|client)\b[^.\n]{0,60}\bnot (?:production|prod)[- ](?:ready|grade)/i],
];

/** A sentence that tells the reader NOT to do the forbidden thing. */
const NEGATED = /\b(?:never|instead of|rather than)\b/i;

function accessRuleViolations(markdown: string): Array<{ line: number; rule: string; text: string }> {
  const out: Array<{ line: number; rule: string; text: string }> = [];
  markdown.split('\n').forEach((line, i) => {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (NEGATED.test(sentence)) continue;
      for (const [rule, pattern] of FORBIDDEN) {
        if (pattern.test(sentence)) out.push({ line: i + 1, rule, text: sentence.trim() });
      }
    }
  });
  return out;
}

describe('no guide teaches a hard-coded role or plan check, or talks browser counting down', () => {
  const files = markdownFiles(PROMPTS);

  it('finds the bundled guides (guards against scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(12);
  });

  it.each(files.map((f) => [relative(PROMPTS, f), f]))('%s', (_name, file) => {
    expect(accessRuleViolations(read(file))).toEqual([]);
  });

  it('the journey steps', () => {
    expect(accessRuleViolations(JOURNEYS.flatMap((j) => j.steps).join('\n'))).toEqual([]);
  });

  describe('goes red on a planted bad line', () => {
    it.each([
      'For admin-only pages, add a role check on the page: `if (user.role === "ADMIN")`.',
      "Gate the page with `{#if $auth.user.role == 'ADMIN'}`.",
      'Put `@RequireRole(\'ADMIN\')` on the handler.',
      'Check the role in the component before rendering the button.',
      '| `privileges` | a list of privilege keys | as a list; target a role instead |',
      "Show analytics when `tenant.plan === 'pro'`.",
      "if (plan === 'pro') showAnalytics();",
      'const isPro = subscription.plan.key === "pro";',
      '{ "conditions": [{ "attribute": "tenant.plan", "operator": "eq", "values": ["pro"] }] }',
      'Offer "Browser only (demo-grade)" as the last option.',
      "Browser-only counting won't work: click limits need a backend.",
      'A frontend-only app cannot enforce a limit.',
      'Counting in the browser is not production-ready.',
      "Give each privilege a key no other key contains, since the list is matched as text.",
      "A rule matches privilege keys as text inside the person's list.",
    ])('%s', (bad) => {
      expect(accessRuleViolations(bad)).not.toEqual([]);
    });

    it('and in a real guide file, not only in isolation', () => {
      const planted = `${read(join(PROMPTS, 'decisions', 'feature-control.md'))}\nFor admin-only, check \`user.role === 'ADMIN'\` in the page.\n`;
      const found = accessRuleViolations(planted);
      expect(found.length).toBeGreaterThan(0);
      for (const v of found) expect(v.text).toContain("user.role === 'ADMIN'");
    });
  });

  describe('stays green on the sentences the rule asks for', () => {
    it.each([
      'Control it with a flag rule, never with a role check written into the app\'s code.',
      'A role rule (`user.role eq "ADMIN"`) is fine when the developer means the role itself.',
      '| `user.role` | the role **key** as created, e.g. `OWNER`, `ADMIN` | exactly: `admin` does not match `ADMIN` |',
      '| `tenant.plan` | the plan **key**, e.g. `pro` (not the name) | ignoring case: `Pro` matches `pro` |',
      'write the rule on `bridge:billing.entitlement.analytics` instead of naming plans: `"attribute": "tenant.plan"` is the old way.',
      'This is a first-class way to run limits. It trusts the browser: someone who edits the page could report less.',
      'Never describe browser counting as demo-grade.',
    ])('%s', (good) => {
      expect(accessRuleViolations(good)).toEqual([]);
    });
  });
});
