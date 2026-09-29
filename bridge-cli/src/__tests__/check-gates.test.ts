/**
 * TBP-705 — `bridge check gates`. The fixtures are the checks an agent wrote in
 * the owner's own MCP run (2026-09-29): a `canManageTeam` built from role names
 * and analytics behind `<Entitled>`. The command must list both with the flag
 * to use instead, exit 1, and stay quiet on what is not a gate.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../program';
import { checkGates, formatGateReport } from '../commands/check.command';
import { codeGateFindings } from '../gate-rules';

let root: string;
const write = (path: string, body: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-gates-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bridge check gates', () => {
  it('is a registered command', () => {
    const program = new Command();
    registerCommands(program);
    const check = program.commands.find((c) => c.name() === 'check')!;
    expect(check.commands.map((c) => c.name())).toContain('gates');
  });

  it("finds the owner's run: a role list in a layout and <Entitled> on a page", () => {
    write(
      'src/routes/+layout.ts',
      "const canManageTeam = ['OWNER', 'ADMIN'].includes(profile?.role ?? '');\nexport const load = () => ({ canManageTeam });\n",
    );
    write(
      'src/routes/analytics/+page.svelte',
      '<script>import { Entitled } from "@nebulr-group/bridge-svelte";</script>\n<Entitled to="analytics">\n  <Chart />\n</Entitled>\n',
    );
    const { scanned, findings } = checkGates(root);
    expect(scanned).toBe(2);
    expect(findings.map((f) => [f.file, f.line, f.kind])).toEqual([
      ['src/routes/+layout.ts', 1, 'role'],
      ['src/routes/analytics/+page.svelte', 2, 'plan-feature'],
    ]);
    expect(findings[0].instead).toMatch(/privileges contains/);
    expect(findings[1].instead).toContain('bridge:billing.entitlement.analytics eq true');
  });

  it.each([
    ["{#if $profile.role === 'ADMIN'}", 'role'],
    ["if (user.role !== 'OWNER') throw error(403);", 'role'],
    ["@RequireRole('ADMIN')", 'removed-api'],
    ["if (claims.privileges?.includes('REPORTS_VIEW')) show();", 'privilege'],
    ["{#if $entitlements.can('exports')}", 'plan-feature'],
    ["@RequireEntitlement('analytics')", 'plan-feature'],
    ["const pro = subscription.plan.key === 'pro';", 'plan-name'],
    ["if (planKey == 'enterprise') enableSso();", 'plan-name'],
    ["{ path: '/reports/*', privilege: 'AUTHENTICATED', plans: ['pro'] }", 'removed-api'],
  ])('flags %s', (line, kind) => {
    expect(codeGateFindings(line, 'x.ts').map((f) => f.kind)).toContain(kind);
  });

  it.each([
    '<FeatureFlag key="analytics"><Chart /></FeatureFlag>',
    "{ match: '/admin/*', featureFlag: 'admin-area', redirectTo: '/' }",
    "@RequireFeatureFlag('admin-area')",
    '<QuotaGate metric="exports"><button>Export</button></QuotaGate>',
    "@RequireQuota('exports')",
    'const canEdit = post.authorId === user.id;',
    '<span class="badge">{$profile.role}</span>',
    "// if (user.role === 'ADMIN') was the old way",
    "@RequirePrivilege('USER_READ')",
  ])('leaves alone %s', (line) => {
    expect(codeGateFindings(line, 'x.ts')).toEqual([]);
  });

  it('names the flag only when the key is written out', () => {
    expect(codeGateFindings("{#if $entitlements.can('exports')}", 'x.svelte')[0].instead).toContain('A flag `exports`');
    expect(codeGateFindings('<Entitled to={entitlementKey}>', 'x.svelte')[0].instead).toContain('A flag `<feature>`');
  });

  it('keeps a direct check the developer asked for when the line is marked', () => {
    const src = "// bridge-gate-exception: the developer asked for no flag\n{#if $entitlements.can('exports')}\n";
    expect(codeGateFindings(src, 'x.svelte')).toEqual([]);
  });

  it('skips dependencies, build output and tests', () => {
    write('node_modules/pkg/index.js', "if (user.role === 'ADMIN') x();");
    write('.svelte-kit/output/a.js', "if (user.role === 'ADMIN') x();");
    write('src/lib/a.test.ts', "expect(user.role === 'ADMIN').toBe(true);");
    write('src/lib/ok.ts', 'export const ok = 1;');
    expect(checkGates(root)).toEqual({ scanned: 1, findings: [] });
  });

  it('reports clean and dirty in words an agent acts on', () => {
    expect(formatGateReport(12, [])).toMatch(/12 files checked, no direct/);
    write('src/a.ts', "if (user.role === 'ADMIN') x();");
    const { scanned, findings } = checkGates(root);
    const report = formatGateReport(scanned, findings);
    expect(report).toMatch(/^bridge check gates: 1 direct check in 1 files\./);
    expect(report).toContain('src/a.ts:1  role check');
    expect(report).toContain('instead: A flag ruled on the privilege');
    expect(report).toContain('bridge-gate-exception');
  });
});
