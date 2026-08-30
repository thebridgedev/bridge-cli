/**
 * TBP-206 — Unit tests for `bridge guide flags` framework resolution and
 * master-prompt loading. Per-framework flags prompts are not bundled in the
 * CLI; they always come from the plugin repo's `mcp/feature-flags-prompt.md`
 * (fetched via fetchGuide → not covered here).
 */

jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
);

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFlagsFramework, fetchFlagsMasterPrompt } from '../commands/guide.command';

describe('resolveFlagsFramework', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  async function projectWith(deps: Record<string, string>): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'bridge-cli-guide-flags-'));
    dirs.push(d);
    await writeFile(
      join(d, 'package.json'),
      JSON.stringify({ name: 't', dependencies: deps }),
      'utf8',
    );
    return d;
  }

  it('honors an explicit override', async () => {
    const cwd = await projectWith({});
    await expect(resolveFlagsFramework('react', cwd)).resolves.toBe('react');
  });

  it('rejects an invalid override', async () => {
    const cwd = await projectWith({});
    await expect(resolveFlagsFramework('vue', cwd)).rejects.toThrow(/Unknown --framework/);
  });

  it('detects nextjs over react', async () => {
    const cwd = await projectWith({ next: '14', react: '18' });
    await expect(resolveFlagsFramework(undefined, cwd)).resolves.toBe('nextjs');
  });

  it('returns undefined when no framework signal exists', async () => {
    const cwd = await projectWith({ lodash: '^4.0.0' });
    await expect(resolveFlagsFramework(undefined, cwd)).resolves.toBeUndefined();
  });
});

describe('fetchFlagsMasterPrompt', () => {
  it('loads the bundled flags master orchestrator', async () => {
    const content = await fetchFlagsMasterPrompt();
    expect(content).toMatch(/Master Integration Prompt/);
    expect(content).toMatch(/state.*off.*on.*on-with-rule/i);
    // The master must surface the plugin-repo route — that's the contract
    // with per-framework prompts living in each plugin's mcp/ folder.
    expect(content).toMatch(/mcp\/feature-flags-prompt\.md/);
  });
});
