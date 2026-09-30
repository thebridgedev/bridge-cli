// TBP-705 — `bridge check gates`: the last step of every integration guide.
//
// The owner's rule (2026-09-29) is that every gate in app code is a flag. An
// agent in the owner's own test run still wrote `canManageTeam` from a list of
// role names and wrapped analytics in `<Entitled>`, because nothing checked the
// result. This command lists each direct role, privilege, plan or plan-feature
// check in the project with the flag to use instead, and exits 1 while any is
// left, so "done" is something the agent can verify rather than assert.
//
// Local and read-only: it reads the developer's sources and calls nothing.

import { Command } from 'commander';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { outputError, outputPrompt, outputSuccess } from '../output.js';
import {
  GATE_EXCEPTION_MARKER,
  SKIPPED_DIRS,
  codeGateFindings,
  isScannedSource,
  type GateFinding,
} from '../gate-rules.js';

export function projectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(name) && !name.startsWith('.')) walk(path);
      } else if (isScannedSource(name)) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function checkGates(root: string): { scanned: number; findings: GateFinding[] } {
  const files = projectSourceFiles(root);
  const findings = files.flatMap((file) => codeGateFindings(readFileSync(file, 'utf-8'), relative(root, file)));
  return { scanned: files.length, findings };
}

const KIND_LABEL: Record<GateFinding['kind'], string> = {
  role: 'role check',
  privilege: 'privilege check',
  'plan-feature': 'plan-feature check',
  'plan-name': 'plan-name check',
  'removed-api': 'removed API',
};

export function formatGateReport(scanned: number, findings: GateFinding[]): string {
  if (findings.length === 0) {
    return `bridge check gates: ${scanned} files checked, no direct role, privilege, plan or plan-feature checks. Every gate goes through a flag.\n`;
  }
  const lines = [
    `bridge check gates: ${findings.length} direct check${findings.length === 1 ? '' : 's'} in ${scanned} files.`,
    '',
    'Every gate in app code is a flag: its rule says why (a privilege, a plan feature, a rollout).',
    'Replace each check below, then run this again until it is clean. The flag rules themselves are set with',
    '`bridge flag` / the MCP flag tools; read the app\'s roles first with `bridge role list`.',
    '',
  ];
  for (const f of findings) {
    lines.push(`${f.file}:${f.line}  ${KIND_LABEL[f.kind]}`);
    lines.push(`    ${f.text}`);
    lines.push(`    instead: ${f.instead}`);
    lines.push('');
  }
  lines.push(
    'Not gates, and fine as they are: plan limits (`<QuotaGate>`, `useQuota`, `@RequireQuota`, `bridge.requireQuota`) and permission on one',
    `specific record ("only the author edits their post"). A direct check the developer explicitly asked for stays with a`,
    `\`// ${GATE_EXCEPTION_MARKER}: <reason>\` comment on the line or the line above.`,
  );
  return lines.join('\n') + '\n';
}

export function registerCheckCommands(program: Command): void {
  const check = program.command('check').description('Check the project against Bridge\'s rules (local, read-only)');

  check
    .command('gates')
    .description(
      'List every direct role, privilege, plan or plan-feature check in the project, with the flag to use instead. Exits 1 while any is left.',
    )
    .option('--cwd <path>', 'Project directory (defaults to current)', process.cwd())
    .option('--json', 'Print the findings as JSON')
    .action((opts: { cwd: string; json?: boolean }) => {
      try {
        const root = resolve(opts.cwd);
        const { scanned, findings } = checkGates(root);
        if (opts.json) outputSuccess({ scanned, findings });
        else outputPrompt(formatGateReport(scanned, findings));
        if (findings.length > 0) process.exitCode = 1;
      } catch (error) {
        outputError(error);
      }
    });
}
