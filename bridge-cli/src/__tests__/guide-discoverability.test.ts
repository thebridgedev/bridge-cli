/**
 * TBP-540 (folds TBP-599) — the guide a developer needs is reachable from the
 * command they actually ran.
 *
 * A port with bridge-svelte installed hand-wrote its login form against a
 * guessed endpoint because `bridge guide svelte` never mentioned that an
 * in-app-forms guide exists. So the framework guide opens by naming both
 * sign-in modes, and a failed `bridge guide <framework> <x>` names the guides
 * that do exist. `fetch` (GitHub) is the only fake.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputPrompt: jest.fn(), outputError: jest.fn() }));

import { Command } from 'commander';
import { registerCommands } from '../program';
import { outputError, outputPrompt } from '../output.js';
import { authModesPreface, loadGuideCoverage } from '../commands/guide.command';

const realFetch = global.fetch;
let served: Record<string, string>;

beforeEach(() => {
  delete process.env.BRIDGE_GUIDE_LOCAL_DIR;
  served = {};
  (outputPrompt as jest.Mock).mockReset();
  (outputError as jest.Mock).mockReset();
  global.fetch = jest.fn(async (url: string) => {
    const key = Object.keys(served).find((k) => String(url).endsWith(k));
    return (key
      ? { ok: true, status: 200, text: async () => served[key] }
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

describe('`bridge guide <framework>` names both sign-in modes', () => {
  it('opens the hosted guide with the in-app-forms alternative, by command', async () => {
    served['bridge-react/main/mcp/integration-prompt.md'] = '# React integration';
    await run('guide', 'react');
    const printed = (outputPrompt as jest.Mock).mock.calls[0][0] as string;
    expect(printed).toMatch(/^> \*\*Two ways to sign in/);
    expect(printed).toContain('`bridge guide react sdk-auth`');
    expect(printed).toMatch(/never write a login form or call Bridge auth endpoints by hand/);
    expect(printed.endsWith('# React integration')).toBe(true);
  });

  it('only where an SDK-auth guide exists (backends are unchanged)', () => {
    const { frameworks } = loadGuideCoverage();
    for (const fw of ['svelte', 'react', 'angular', 'nextjs']) expect(authModesPreface(fw, frameworks)).toContain(`bridge guide ${fw} sdk-auth`);
    for (const fw of ['nestjs', 'express']) expect(authModesPreface(fw, frameworks)).toBeNull();
  });

  it('leaves a named feature guide as it is', async () => {
    served['bridge-angular/main/mcp/sdk-auth-prompt.md'] = '# Angular SDK auth';
    await run('guide', 'angular', 'sdk-auth');
    expect(outputPrompt).toHaveBeenCalledWith('# Angular SDK auth');
  });
});

describe('a failed `bridge guide <framework> <x>` names the guides that exist', () => {
  it('lists them from guide-coverage.json', async () => {
    await run('guide', 'nestjs', 'sdk-auth');
    const err = (outputError as jest.Mock).mock.calls[0][0] as Error & { code?: string };
    expect(err.code).toBe('GUIDE_NOT_FOUND');
    expect(err.message).toContain(`Guides for nestjs: ${loadGuideCoverage().frameworks.nestjs.join(', ')}`);
    expect(err.message).toContain('`bridge guide list`');
  });
});
