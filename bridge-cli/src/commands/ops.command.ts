/**
 * `bridge ops` — operator / platform-internal commands.
 *
 * Phase E of Billing 2.0 (US-18) is hidden-hero: there is no admin-UI surface
 * for the reconciliation pipeline. Operators trigger / inspect it through this
 * CLI subcommand, which calls the `/admin/reconcile/...` endpoints on
 * bridge-api directly. Auth re-uses the standard CLI credentials (TBP-111
 * loopback PKCE flow → `x-api-key: <jwt>`).
 *
 * Subcommands:
 *   bridge ops reconcile --workspace <id>
 *   bridge ops reconcile --workspace <id> --metric <metric>
 *   bridge ops reconcile --workspace <id> [--json]
 */
import { Command } from 'commander';
import { DEFAULT_BASE_URL } from '../config.js';
import { isExpired, readCredentials } from '../credentials.js';
import { outputError, outputSuccess } from '../output.js';

interface ReconciliationMetricResult {
  metric: string;
  periodStart: string;
  periodEnd: string;
  bridgeCount: number;
  providerCount: number;
  missing: number;
  extra: number;
  healed: number;
  failed: string[];
  status: 'no-drift' | 'resolved' | 'unrecoverable' | 'partial' | 'skipped';
  attempts: number;
}

interface ReconciliationResult {
  workspaceId: string;
  appId: string;
  metrics: ReconciliationMetricResult[];
}

export function registerOpsCommands(program: Command): void {
  const ops = program
    .command('ops')
    .description('Operator / platform-internal commands');

  ops
    .command('reconcile')
    .description(
      'Trigger Bridge↔Stripe usage reconciliation for a workspace (Billing 2.0 US-18). ' +
        'Diffs Bridge raw events against Stripe usage records and replays the missing ones.',
    )
    .requiredOption('--workspace <id>', 'Workspace (tenant) id to reconcile')
    .option('--metric <metric>', 'Scope to one metric instead of all metered metrics')
    .option('--json', 'Emit raw JSON instead of the human-readable table')
    .action(async (opts: { workspace: string; metric?: string; json?: boolean }) => {
      try {
        const result = await callReconcile(opts.workspace, opts.metric);
        if (opts.json) {
          outputSuccess(result);
          return;
        }
        // Default: render a friendly table; still go through outputSuccess so
        // the success envelope + exit code stay consistent with the rest of the
        // CLI. The pretty table is appended to stderr so machine parsers that
        // only watch stdout get the JSON.
        printReconciliationTable(result);
        outputSuccess(result);
      } catch (err) {
        outputError(err);
      }
    });
}

async function callReconcile(
  workspaceId: string,
  metric?: string,
): Promise<ReconciliationResult> {
  const { apiKey, baseUrl } = resolveCredentials();
  const path = metric
    ? `/v1/admin/reconcile/${encodeURIComponent(workspaceId)}/${encodeURIComponent(metric)}`
    : `/v1/admin/reconcile/${encodeURIComponent(workspaceId)}`;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: '{}',
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => '');
    }
    const message =
      (body && typeof body === 'object' && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : '') || `HTTP ${res.status}`;
    const err: Error & { status?: number; body?: unknown } = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return (await res.json()) as ReconciliationResult;
}

function resolveCredentials(): { apiKey: string; baseUrl: string } {
  const envKey = process.env.BRIDGE_API_KEY?.trim();
  const envBase = process.env.BRIDGE_BASE_URL?.trim();
  const creds = safeReadCredentials();

  if (creds && !isExpired(creds)) {
    return {
      apiKey: creds.apiKey,
      baseUrl: envBase && envBase.length > 0 ? envBase : creds.baseUrl,
    };
  }
  if (envKey && envKey.length > 0) {
    return {
      apiKey: envKey,
      baseUrl: envBase && envBase.length > 0 ? envBase : DEFAULT_BASE_URL,
    };
  }
  throw new Error('Not logged in. Run `bridge auth login`.');
}

function safeReadCredentials() {
  try {
    return readCredentials();
  } catch {
    return null;
  }
}

function printReconciliationTable(result: ReconciliationResult): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`workspace=${result.workspaceId} app=${result.appId}`);
  if (result.metrics.length === 0) {
    lines.push('  (no metered metrics reconciled)');
    process.stderr.write(lines.join('\n') + '\n');
    return;
  }
  const header = [
    'metric'.padEnd(28),
    'status'.padEnd(14),
    'bridge'.padStart(7),
    'provider'.padStart(9),
    'missing'.padStart(8),
    'healed'.padStart(7),
    'attempts'.padStart(9),
  ].join(' ');
  lines.push(header);
  lines.push('-'.repeat(header.length));
  for (const m of result.metrics) {
    lines.push(
      [
        m.metric.padEnd(28).slice(0, 28),
        m.status.padEnd(14),
        String(m.bridgeCount).padStart(7),
        String(m.providerCount).padStart(9),
        String(m.missing).padStart(8),
        String(m.healed).padStart(7),
        String(m.attempts).padStart(9),
      ].join(' '),
    );
    if (m.failed.length > 0) {
      lines.push(`    failed: ${m.failed.slice(0, 3).join('; ')}`);
    }
  }
  lines.push('');
  process.stderr.write(lines.join('\n') + '\n');
}
