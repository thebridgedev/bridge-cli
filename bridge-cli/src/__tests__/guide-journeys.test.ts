/**
 * TBP-712 — `bridge guide <journey>` reaches the same seven journeys as the
 * Bridge MCP server's prompts, composed the same way: the decision guide when
 * TBP-540 has written it, else the master that exists, then the per-framework
 * guide. And an unknown `bridge guide <x>` names what exists instead of
 * silently printing the master.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { Command } from 'commander';
import { registerCommands } from '../program';
import { CLI_PROMPTS_BASE_URL } from '../prompt-urls';
import { JOURNEYS, composeJourney, fetchDecisionGuide, type JourneySources } from '../commands/journeys';

const COVERAGE: Record<string, string[]> = {
  svelte: ['integration', 'sdk-auth', 'feature-flags', 'billing', 'team'],
  nestjs: ['integration', 'auth', 'feature-flags', 'billing', 'team'],
};

function fixtureSources(decisions: Record<string, string> = {}) {
  const calls: string[] = [];
  const sources: JourneySources = {
    decision: async (d) => {
      calls.push(`decision:${d}`);
      return decisions[d] ?? null;
    },
    master: async (m) => {
      calls.push(`master:${m}`);
      return `# ${m.toUpperCase()} MASTER`;
    },
    frameworkGuide: async (fw, feature) => {
      calls.push(`guide:${fw}/${feature}`);
      return `# ${fw} ${feature} GUIDE`;
    },
    coverage: () => COVERAGE,
  };
  return { sources, calls };
}

describe('the seven journeys (TBP-712)', () => {
  it('are exactly the names the MCP server lists as prompts', () => {
    expect(JOURNEYS.map((j) => j.name)).toEqual([
      'add-login', 'add-paid-plan', 'add-feature-flag', 'add-teams', 'go-live', 'verify-setup', 'whats-wrong',
    ]);
  });

  it('are registered as `bridge guide <journey>`', () => {
    const program = new Command();
    registerCommands(program);
    const guide = program.commands.find((c) => c.name() === 'guide')!;
    for (const j of JOURNEYS) expect(guide.commands.map((c) => c.name())).toContain(j.name);
  });

  it.each([
    ['add-login', 'svelte', ['decision:login', 'master:auth', 'guide:svelte/sdk-auth']],
    ['add-login', 'nestjs', ['decision:login', 'master:auth', 'guide:nestjs/auth']],
    ['add-paid-plan', 'svelte', ['decision:payments', 'master:billing', 'guide:svelte/billing']],
    ['add-feature-flag', 'svelte', ['decision:feature-control', 'master:flags', 'guide:svelte/feature-flags']],
    ['add-teams', 'svelte', ['decision:teams', 'guide:svelte/team']],
    ['go-live', 'svelte', ['decision:going-live']],
    ['verify-setup', 'svelte', []],
    ['whats-wrong', 'svelte', []],
  ])('%s (%s) reads %j', async (name, framework, expected) => {
    const { sources, calls } = fixtureSources();
    const journey = JOURNEYS.find((j) => j.name === name)!;
    const out = await composeJourney(journey, journey.feature ? framework : null, sources);
    expect(calls).toEqual(expected);
    expect(out.guide).toContain(`the \`${name}\` prompt of the Bridge server`);
    expect(out.guide).toMatch(/Product questions .* belong to the developer/);
  });

  it('opens with the decision guide once it exists, and then skips the master', async () => {
    const { sources, calls } = fixtureSources({ login: '# LOGIN DECISION GUIDE' });
    const out = await composeJourney(JOURNEYS[0], null, sources);
    expect(out.opensWith).toBe('decision');
    expect(out.guide).toContain('# LOGIN DECISION GUIDE');
    expect(calls).not.toContain('master:auth');
  });

  it('says plainly when it falls back to the master', async () => {
    const { sources } = fixtureSources();
    const out = await composeJourney(JOURNEYS[0], null, sources);
    expect(out.opensWith).toBe('master');
    expect(out.guide).toMatch(/decision guide for login is not written yet/);
    expect(out.guide).toMatch(/Framework not detected/);
  });

  it('the paid-plan journey offers a /welcome page and never creates one unasked', () => {
    const steps = JOURNEYS.find((j) => j.name === 'add-paid-plan')!.steps.join(' ');
    expect(steps).toMatch(/\/welcome page .* is an offer/);
    expect(steps).toMatch(/only if the developer says yes/);
  });
});

describe('the decision-guide seam (TBP-712)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // The guides are bundled now (TBP-540). A CLI released before a guide was
  // written has no bundled copy: load the seam against an empty install dir.
  function unbundledFetchDecisionGuide(): typeof fetchDecisionGuide {
    let fn!: typeof fetchDecisionGuide;
    jest.isolateModules(() => {
      jest.doMock('../commands/runtime-dir', () => ({ commandsDir: '/nonexistent-bridge-cli/dist/commands' }));
      fn = (require('../commands/journeys') as typeof import('../commands/journeys')).fetchDecisionGuide;
    });
    return fn;
  }

  it('reads prompts/decisions/<domain>.md from bridge-cli on GitHub when not bundled', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '# TEAMS' });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(unbundledFetchDecisionGuide()('teams')).resolves.toBe('# TEAMS');
    expect(fetchMock).toHaveBeenCalledWith(`${CLI_PROMPTS_BASE_URL}/decisions/teams.md`);
    // The doubled segment is what the MCP server reads too: bridge-cli/main/bridge-cli/prompts/decisions/.
    expect(CLI_PROMPTS_BASE_URL).toMatch(/\/bridge-cli\/main\/bridge-cli\/prompts$/);
  });

  it('a 404 means not written yet, not an error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }) as unknown as typeof fetch;
    await expect(unbundledFetchDecisionGuide()('login')).resolves.toBeNull();
  });
});

describe('`bridge guide <unknown>` (TBP-712)', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });
  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  });

  it('names the journeys and frameworks instead of printing the master', async () => {
    const program = new Command();
    registerCommands(program);
    await program.parseAsync(['node', 'bridge', 'guide', 'add-payments']);
    expect(stdout).not.toHaveBeenCalled();
    const err = JSON.parse(String(stderr.mock.calls[0][0]));
    expect(err.error.code).toBe('GUIDE_NOT_FOUND');
    expect(err.error.message).toContain("No guide named 'add-payments'");
    for (const j of JOURNEYS) expect(err.error.message).toContain(j.name);
    expect(err.error.message).toContain('svelte');
    expect(process.exitCode).toBe(1);
  });

  it('a journey name resolves to its composed guide', async () => {
    const program = new Command();
    registerCommands(program);
    await program.parseAsync(['node', 'bridge', 'guide', 'verify-setup', '--json']);
    const out = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(out.data.journey).toBe('verify-setup');
    expect(out.data.guide).toContain('`bridge diagnose`');
  });
});
