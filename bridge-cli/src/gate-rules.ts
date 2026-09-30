/**
 * TBP-705 — the owner's rule for app code (2026-09-29): every gate in app code
 * is a flag. Its rule says why (a privilege, a plan feature, a rollout); app
 * code never reads a role, a privilege list, the plan or a plan feature to
 * decide what someone may see or do. Numbers (plan limits) and permission on
 * one specific record are not gates.
 *
 * Two checks live here, from one list of what a direct check looks like:
 *   - `codeGateFindings`: `bridge check gates`, run by the agent as the last
 *     step of every integration, over the developer's own sources;
 *   - `docGateViolations`: the currency test over the guides we serve, so no
 *     guide teaches the thing the command then flags.
 *
 * bridge-svelte and bridge-nestjs carry a copy of the doc pattern list in
 * their own currency tests. This file is the source; keep them the same.
 */

// ── Code: what `bridge check gates` looks for ───────────────────────────────

export type GateKind = 'role' | 'privilege' | 'plan-feature' | 'plan-name' | 'removed-api';

export type GateFinding = {
  file: string;
  line: number;
  kind: GateKind;
  text: string;
  /** What to use instead, in words an agent can act on. */
  instead: string;
};

/** Written on the line, or the line above, to mark a direct check the developer asked for. */
export const GATE_EXCEPTION_MARKER = 'bridge-gate-exception';

const ROLE_INSTEAD =
  'A flag ruled on the privilege this role stands for (`bridge role list` shows which privileges each role holds), ' +
  'e.g. `privileges contains "USER_WRITE"`. Then `<FeatureFlag key="…">` or a route rule with `featureFlag` in SvelteKit, ' +
  '`@RequireFeatureFlag(\'…\')` in NestJS, `bridge.protect({ featureFlag: \'…\' })` in Express. A role rule (`user.role eq "ADMIN"`) only when the developer means the role itself.';

const PLAN_NAME_INSTEAD =
  'List the feature on the plans that sell it (`bridge plan feature add <plan> <feature>`) and gate with a flag ruled ' +
  '`bridge:billing.entitlement.<feature> eq true`. Never compare plan names in code.';

function planFeatureInstead(key: string | undefined): string {
  const k = key ?? '<feature>';
  return (
    `A flag \`${k}\` ruled \`bridge:billing.entitlement.${k} eq true\` ` +
    '(SvelteKit `<FeatureFlag key>` / route rule `featureFlag`, NestJS `@RequireFeatureFlag`, Express `bridge.protect({ featureFlag })`). ' +
    `A direct plan-feature check is the documented exception: keep it only if the developer asked for no flag, and mark the line \`// ${GATE_EXCEPTION_MARKER}: <reason>\`.`
  );
}

function privilegeInstead(key: string | undefined): string {
  return (
    `A flag ruled \`privileges contains "${key ?? '<PRIVILEGE>'}"\`, read with \`<FeatureFlag key>\` / a route rule ` +
    '`featureFlag` (SvelteKit), `@RequireFeatureFlag` (NestJS) or `bridge.protect({ featureFlag })` (Express).'
  );
}

type CodeCheck = {
  kind: GateKind;
  pattern: RegExp;
  instead: (match: RegExpExecArray) => string;
};

const firstLiteral = (s: string | undefined) => /['"`]([\w.:-]+)['"`]/.exec(s ?? '')?.[1];
const leadingLiteral = (s: string | undefined) => /^\s*\{?\s*['"`]([\w.:-]+)['"`]/.exec(s ?? '')?.[1];

export const CODE_CHECKS: CodeCheck[] = [
  // Roles
  { kind: 'role', pattern: /\.role\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\s*[\w$.?]*\.role\b/, instead: () => ROLE_INSTEAD },
  { kind: 'role', pattern: /\brole\s*(?:===|!==|==|!=)\s*['"`]/i, instead: () => ROLE_INSTEAD },
  { kind: 'role', pattern: /\.includes\(\s*[\w$.?]*\brole\b/i, instead: () => ROLE_INSTEAD },
  { kind: 'role', pattern: /\bhasRole\s*\(/, instead: () => ROLE_INSTEAD },
  { kind: 'role', pattern: /\bcase\s+['"`](?:OWNER|ADMIN|MEMBER)['"`]\s*:/, instead: () => ROLE_INSTEAD },
  {
    kind: 'removed-api',
    pattern: /@RequireRole\s*\(/,
    instead: () => `\`@RequireRole\` is gone. ${ROLE_INSTEAD}`,
  },
  // Privileges read in app code (`@RequirePrivilege` is an API-token scope, not a gate on a person)
  {
    kind: 'privilege',
    pattern: /\bprivileges\s*\??\.\s*(?:includes|some|indexOf|has|find)\s*\(([^)]*)/,
    instead: (m) => privilegeInstead(firstLiteral(m[1])),
  },
  // Plan features read directly. The key is named only when it is written as a literal.
  { kind: 'plan-feature', pattern: /<Entitled\b[^>]*?\bto=(.*)/, instead: (m) => planFeatureInstead(leadingLiteral(m[1])) },
  { kind: 'plan-feature', pattern: /\bentitlements\s*\??\.\s*can\s*\((.*)/, instead: (m) => planFeatureInstead(leadingLiteral(m[1])) },
  { kind: 'plan-feature', pattern: /@RequireEntitlement\s*\((.*)/, instead: (m) => planFeatureInstead(leadingLiteral(m[1])) },
  // Express twin of `@RequireEntitlement` (bridge-express 0.7, TBP-745).
  { kind: 'plan-feature', pattern: /\brequireEntitlement\s*\((.*)/, instead: (m) => planFeatureInstead(leadingLiteral(m[1])) },
  // Plan names compared
  { kind: 'plan-name', pattern: /\bplan(?:Key|Name|Slug|Id)?\s*(?:===|!==|==|!=)\s*['"`]/i, instead: () => PLAN_NAME_INSTEAD },
  { kind: 'plan-name', pattern: /\.plan(?:\??\.(?:key|slug|name|id))?\s*(?:===|!==|==|!=)\s*['"`]/, instead: () => PLAN_NAME_INSTEAD },
  { kind: 'plan-name', pattern: /\bis(?:Pro|Free|Enterprise|Team|Business|Premium)(?:Plan|User)?\b\s*[(=]/, instead: () => PLAN_NAME_INSTEAD },
  // bridge-express 0.7 (TBP-745) removed `protect({ role | plans | entitlement | entitlements })`;
  // each now fails at startup. `plans: [` is caught by the rule below.
  {
    kind: 'removed-api',
    pattern: /\bprotect\s*\(\s*\{[^}]*\brole\s*:/,
    instead: () => `\`bridge.protect({ role })\` is gone in bridge-express 0.7. ${ROLE_INSTEAD}`,
  },
  {
    kind: 'removed-api',
    pattern: /\bprotect\s*\(\s*\{[^}]*\bentitlements?\s*:\s*(.*)/,
    instead: (m) =>
      `\`bridge.protect({ entitlement })\` is gone in bridge-express 0.7. ${planFeatureInstead(leadingLiteral(m[1]))}`,
  },
  {
    kind: 'removed-api',
    pattern: /\bplans\s*:\s*\[/,
    instead: () => `Route rules no longer take \`plans\`. ${PLAN_NAME_INSTEAD}`,
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*|<!--)/;

/** Every direct gate check in one source file. */
export function codeGateFindings(source: string, file: string): GateFinding[] {
  const lines = source.split('\n');
  const out: GateFinding[] = [];
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    if (line.includes(GATE_EXCEPTION_MARKER) || (i > 0 && lines[i - 1].includes(GATE_EXCEPTION_MARKER))) return;
    const seen = new Set<GateKind>();
    for (const check of CODE_CHECKS) {
      if (seen.has(check.kind)) continue;
      const m = check.pattern.exec(line);
      if (!m) continue;
      seen.add(check.kind);
      out.push({ file, line: i + 1, kind: check.kind, text: line.trim(), instead: check.instead(m) });
    }
  });
  return out;
}

export const SOURCE_EXTENSIONS = ['.svelte', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
export const SKIPPED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.svelte-kit', '.next', '.nuxt', '.output', 'coverage', '.turbo', '.vercel',
  '__tests__', 'e2e', 'tests',
]);

export function isScannedSource(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// ── Docs: what no guide may teach ───────────────────────────────────────────

export const DOC_FORBIDDEN: Array<[string, RegExp]> = [
  ['a role compared in code', /\b(?:user|session|claims|token|me|currentUser|profile|locals\.user|req\.user|\$user|\$profile)\??\.role\s*(?:===|!==|==|!=)/],
  ['a role compared in code', /\brole\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a role list checked in code', /\[\s*['"][A-Z_]+['"](?:\s*,\s*['"][A-Z_]+['"])*\s*\]\s*\.includes\(/],
  ['a role checked in code', /\bhasRole\s*\(/],
  ['a role decorator on a handler', /@RequireRole\s*\(/],
  ['a role check on the page', /\brole check\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|handler|layout|controller)/i],
  ['a role check on the page', /\bcheck\w*\b[^.\n]{0,30}\brole\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|layout)\b/i],
  ['"target a role instead"', /target a role instead/i],
  ['privileges read in code', /\bprivileges\s*\??\.\s*(?:includes|some|indexOf|has)\s*\(/],
  ['a direct plan-feature check', /<Entitled\b/],
  ['a direct plan-feature check', /\bentitlements\s*\??\.\s*can\s*\(/],
  ['a direct plan-feature check', /@RequireEntitlement\s*\(/],
  ['a direct plan-feature check', /\brequireEntitlement\s*\(/],
  ['a removed Express protect option', /\bprotect\s*\(\s*\{[^}\n]*\b(?:role|plans|entitlements?)\s*:/],
  ['a plan name compared in code', /\.plan(?:Key|Name|Slug)?\s*(?:===|!==|==|!=)\s*['"`]/],
  ['a plan name compared in code', /\bplan(?:Key|Name|Slug)?\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a plan-name helper', /\bis(?:Pro|Free|Enterprise|Team|Business)(?:Plan|User)?\b\s*[(=]/],
  ['a route rule on plans', /\bplans\s*:\s*\[/],
  ['a route rule on a role', /\{[^}\n]*\b(?:match|path)\s*:[^}\n]*\brole\s*:\s*['"`]/],
  ['a route rule on a privilege', /\bprivilege\s*:\s*['"`](?!ANONYMOUS|AUTHENTICATED)[A-Z_]+['"`]/],
  ['a flag rule that names plans', /"attribute"\s*:\s*"(?:tenant\.plan|bridge:billing\.plan)"/],
  ['browser counting called demo-grade', /demo[- ]grade/i],
  ['browser counting called display only', /display,? not enforcement/i],
  ['browser counting said unable to refuse', /only (?:a|the|your) backend can (?:refuse|enforce|stop)/i],
  [
    'browser counting said not to work',
    /\b(?:browser|frontend|client)(?:[- ](?:only|side))?\b[^.\n]{0,40}\b(?:won't|will not|does not|doesn't|cannot|can't|can not) (?:work|enforce|be trusted)/i,
  ],
  ['browser counting said not production-ready', /\b(?:browser|frontend|client)\b[^.\n]{0,60}\bnot (?:production|prod)[- ](?:ready|grade)/i],
  // TBP-757: `contains` on privileges is exact membership; advice written around the old substring match is stale.
  ['privileges said to match as text', /\b(?:matched|matches|match) (?:privilege keys )?as text\b|\bno other (?:privilege )?key contains\b/i],
];

/** A sentence that tells the reader NOT to do the forbidden thing. */
const NEGATED = /\b(?:never|instead of|rather than|do not|don't|not a|is gone|no longer)\b/i;

const HEADING = /^(#{1,6})\s+(.*)$/;

export type DocViolation = { line: number; rule: string; text: string };

/**
 * Every sentence in a guide that teaches a direct check, outside the one
 * section a guide may have whose heading says "Exceptions".
 */
export function docGateViolations(markdown: string): DocViolation[] {
  const out: DocViolation[] = [];
  let exceptionLevel = 0; // heading depth of the Exceptions section we are in, 0 = none
  let inFence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (exceptionLevel && level <= exceptionLevel) exceptionLevel = 0;
      if (/exception/i.test(heading[2])) exceptionLevel = level;
      return;
    }
    if (exceptionLevel) return;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (NEGATED.test(sentence)) continue;
      for (const [rule, pattern] of DOC_FORBIDDEN) {
        if (pattern.test(sentence)) out.push({ line: i + 1, rule, text: sentence.trim() });
      }
    }
  });
  return out;
}
