/**
 * TBP-806 — removing a plan from the command line.
 *
 * `bridge plan delete` only deletes a plan no workspace is on; the server
 * refuses one that workspaces are on (409 PLAN_IN_USE) with the choices, and
 * the command prints that refusal. `--dry-run` asks the delete's read-only
 * preview route and never sends a DELETE. `bridge plan archive` archives (or,
 * with --undo, brings back) a plan, and `bridge tenant set-plan` moves a
 * workspace off a plan — the same route as the dashboard's plan picker.
 *
 * Mirrors the bridge-api MCP specs for delete_plan / archive_plan /
 * set_tenant_plan (mcp/tools/__tests__/write-tools.spec.ts, tenants-crud.spec.ts).
 */

jest.mock('../config.js', () => ({
  ConfigError: class ConfigError extends Error {},
  getManagementClient: jest.fn(),
  getManagementHttp: jest.fn(),
  resolveTenantId: (opts: { tenantId?: string }) => opts.tenantId ?? 'tenant-from-env',
}));

import { Command } from 'commander';
import { HttpError } from '@nebulr-group/bridge-auth-core';
import { getManagementClient, getManagementHttp } from '../config';
import { registerPlanCommands } from '../commands/plan.command';
import { registerTenantCommands } from '../commands/tenant.command';

const mockClient = getManagementClient as jest.Mock;
const mockHttp = getManagementHttp as jest.Mock;

async function runCli(...args: string[]) {
  let stdout = '';
  let stderr = '';
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout += String(c); return true; });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr += String(c); return true; });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerPlanCommands(program);
  registerTenantCommands(program);
  try {
    await program.parseAsync(['node', 'bridge', ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return {
    exitCode,
    data: stdout ? JSON.parse(stdout).data : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}

function httpMock() {
  const http = {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  };
  mockHttp.mockReturnValue(http);
  return http;
}

beforeEach(() => jest.resetAllMocks());

describe('bridge plan delete (TBP-806)', () => {
  const REFUSE_PREVIEW = {
    dryRun: true,
    target: { id: 'plan_1', key: 'pro', name: 'Pro', archived: false },
    affects: { action: 'refuse', workspaceCount: 2, workspaces: [{ id: 't1', name: 'Acme' }, { id: 't2', name: null }] },
    sideEffects: ['The delete will be refused and nothing removed: 2 workspaces are on this plan. Archive the plan instead ...'],
  };

  it('--dry-run asks the read-only preview route and never sends a DELETE', async () => {
    const http = httpMock();
    http.get.mockResolvedValue(REFUSE_PREVIEW);
    const res = await runCli('plan', 'delete', '--key', 'pro', '--dry-run');
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith('/v1/account/payments/plan/pro/deletion-preview', undefined);
    expect(http.delete).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
    expect(res.exitCode).toBeUndefined();
    expect(res.data).toEqual(expect.objectContaining(REFUSE_PREVIEW));
    expect(res.data.next).toContain('Nothing was changed');
  });

  it('--dry-run against a server without the preview route (404) fails and deletes nothing', async () => {
    const http = httpMock();
    http.get.mockRejectedValue(new HttpError('Cannot GET', 404, { message: 'Cannot GET /v1/x/deletion-preview', error: 'Not Found', statusCode: 404 }));
    const res = await runCli('plan', 'delete', '--key', 'pro', '--dry-run');
    expect(http.delete).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('PREVIEW_NOT_SUPPORTED');
  });

  it('without --dry-run: DELETEs the key-addressed route and prints the server answer', async () => {
    const http = httpMock();
    http.delete.mockResolvedValue({ action: 'deleted', key: 'pro' });
    const res = await runCli('plan', 'delete', '--key', 'pro');
    expect(http.delete).toHaveBeenCalledTimes(1);
    expect(http.delete).toHaveBeenCalledWith('/v1/account/payments/plan/pro');
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled(); // never archives on its own
    expect(res.data).toEqual({ action: 'deleted', key: 'pro' });
  });

  it('URL-encodes the key on both routes', async () => {
    const http = httpMock();
    http.get.mockResolvedValue(REFUSE_PREVIEW);
    http.delete.mockResolvedValue({ action: 'deleted', key: 'pro plan/x' });
    await runCli('plan', 'delete', '--key', 'pro plan/x', '--dry-run');
    expect(http.get).toHaveBeenCalledWith('/v1/account/payments/plan/pro%20plan%2Fx/deletion-preview', undefined);
    await runCli('plan', 'delete', '--key', 'pro plan/x');
    expect(http.delete).toHaveBeenCalledWith('/v1/account/payments/plan/pro%20plan%2Fx');
  });

  it('a plan workspaces are on: prints the 409 PLAN_IN_USE refusal with the server fix, exit 1', async () => {
    const http = httpMock();
    const fix = 'Archive the plan instead ... (`bridge plan archive --key pro`, or archive_plan).';
    http.delete.mockRejectedValue(new HttpError("Nothing was deleted: 2 workspaces are on plan 'pro'.", 409, {
      statusCode: 409, nblocksCode: 'PLAN_IN_USE', message: "Nothing was deleted: 2 workspaces are on plan 'pro'.", fix, workspaceCount: 2,
    }));
    const res = await runCli('plan', 'delete', '--key', 'pro');
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('PLAN_IN_USE');
    expect(res.error.message).toContain('Nothing was deleted');
    expect(res.error.hint).toBe(fix);
    expect(res.error.details).toEqual(expect.objectContaining({ workspaceCount: 2 }));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('requires --key', async () => {
    httpMock();
    await expect(runCli('plan', 'delete')).rejects.toThrow(/--key/);
  });
});

describe('bridge plan archive (TBP-806)', () => {
  it('archives: POSTs { archived: true } to the archive route and prints the answer', async () => {
    const http = httpMock();
    http.post.mockResolvedValue({ action: 'archived', key: 'pro', workspaces: 2 });
    const res = await runCli('plan', 'archive', '--key', 'pro');
    expect(http.post).toHaveBeenCalledWith('/v1/account/payments/plan/pro/archive', { archived: true });
    expect(http.delete).not.toHaveBeenCalled();
    expect(res.data).toEqual({ action: 'archived', key: 'pro', workspaces: 2 });
  });

  it('--undo brings an archived plan back', async () => {
    const http = httpMock();
    http.post.mockResolvedValue({ action: 'unarchived', key: 'pro', workspaces: 2 });
    const res = await runCli('plan', 'archive', '--key', 'pro', '--undo');
    expect(http.post).toHaveBeenCalledWith('/v1/account/payments/plan/pro/archive', { archived: false });
    expect(res.data.action).toBe('unarchived');
  });

  it('URL-encodes the key, and reports a server error', async () => {
    const http = httpMock();
    http.post.mockRejectedValue(new HttpError('Plan not found', 404, { message: 'Plan not found', statusCode: 404 }));
    const res = await runCli('plan', 'archive', '--key', 'a b');
    expect(http.post).toHaveBeenCalledWith('/v1/account/payments/plan/a%20b/archive', { archived: true });
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('HTTP_404');
  });
});

describe('bridge tenant set-plan (TBP-806)', () => {
  const PLANS = [
    { key: 'free', prices: [{ currency: 'USD', recurrenceInterval: 'month', amount: 0 }] },
    {
      key: 'pro',
      prices: [
        { currency: 'USD', recurrenceInterval: 'month', amount: 10 },
        { currency: 'EUR', recurrenceInterval: 'year', amount: 100 },
      ],
    },
    { key: 'empty', prices: [] },
  ];

  function setup(tenants = [{ id: 't1', name: 'Acme' }]) {
    mockClient.mockReturnValue({
      tenants: { list: jest.fn().mockResolvedValue(tenants) },
      plans: { list: jest.fn().mockResolvedValue(PLANS) },
    });
    const http = httpMock();
    http.post.mockResolvedValue({});
    return http;
  }

  it('by --name, no price options: POSTs the plan with its FIRST price to planDetails', async () => {
    const http = setup();
    const res = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'pro');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledWith('/v1/account/tenant/t1/planDetails', {
      planKey: 'pro', priceOffer: { currency: 'USD', recurrenceInterval: 'month' },
    });
    expect(res.data).toEqual({ id: 't1', plan: 'pro', price: { currency: 'USD', recurrenceInterval: 'month', amount: 10 } });
  });

  it('by --id, picking the price by --interval and lower-case --currency', async () => {
    const http = setup();
    await runCli('tenant', 'set-plan', '--id', 't1', '--plan', 'pro', '--interval', 'year', '--currency', 'eur');
    expect(http.post).toHaveBeenCalledWith('/v1/account/tenant/t1/planDetails', {
      planKey: 'pro', priceOffer: { currency: 'EUR', recurrenceInterval: 'year' },
    });
  });

  it('an unknown plan fails with the existing keys and changes nothing', async () => {
    const http = setup();
    const res = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'ghost');
    expect(res.exitCode).toBe(1);
    expect(res.error.message).toContain('Plan not found: ghost');
    expect(res.error.message).toContain('free, pro, empty');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('no matching price (or a plan without prices) fails and changes nothing', async () => {
    const http = setup();
    const res = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'pro', '--interval', 'year', '--currency', 'USD');
    expect(res.exitCode).toBe(1);
    expect(res.error.message).toContain('USD month 10');
    const empty = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'empty');
    expect(empty.exitCode).toBe(1);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('an unknown or ambiguous tenant name fails and changes nothing', async () => {
    let http = setup();
    const missing = await runCli('tenant', 'set-plan', '--name', 'Nope', '--plan', 'pro');
    expect(missing.exitCode).toBe(1);
    expect(missing.error.code).toBe('TENANT_NOT_FOUND');
    expect(http.post).not.toHaveBeenCalled();

    http = setup([{ id: 't1', name: 'Acme' }, { id: 't2', name: 'Acme' }]);
    const ambiguous = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'pro');
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.error.code).toBe('TENANT_AMBIGUOUS');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('a server refusal (e.g. archived plan, 400) is reported', async () => {
    const http = setup();
    http.post.mockRejectedValue(new HttpError("Plan 'pro' is no longer offered", 400, { message: "Plan 'pro' is no longer offered", statusCode: 400 }));
    const res = await runCli('tenant', 'set-plan', '--name', 'Acme', '--plan', 'pro');
    expect(res.exitCode).toBe(1);
    expect(res.error.code).toBe('HTTP_400');
  });
});

describe('command registration (TBP-806)', () => {
  it('registers plan delete, plan archive and tenant set-plan', () => {
    const program = new Command();
    registerPlanCommands(program);
    registerTenantCommands(program);
    const sub = (parent: string) => program.commands.find((c) => c.name() === parent)!.commands.map((c) => c.name());
    expect(sub('plan')).toEqual(expect.arrayContaining(['delete', 'archive']));
    expect(sub('tenant')).toEqual(expect.arrayContaining(['set-plan']));
  });
});
