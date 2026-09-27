/**
 * TBP-541 — `bridge diagnose`, `bridge setup status`, `bridge test-user
 * create|verify`, `bridge event auth-attempts`.
 *
 * Load-bearing: `bridge diagnose` reads the project's .env files, and the
 * value of BRIDGE_API_KEY (or any secret) must never leave the machine — only
 * the fact that it is set. Asserted on the actual request body.
 */
const post = jest.fn();
const get = jest.fn();

jest.mock('../config.js', () => ({
  getManagementHttp: () => ({ post, get }),
}));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputError: jest.fn() }));

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { outputError, outputSuccess } from '../output.js';
import {
  bridgeEnvToSend, checkPluginWiring, diagnose, fixToHint, parseDotenv, registerIntegrationCommands, SECRET_PLACEHOLDER,
} from '../commands/integration.command.js';

const SECRET = 'eyJhbGciOiJQUzI1NiJ9.the-real-management-key';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-diagnose-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.command('setup');
  program.command('event');
  registerIntegrationCommands(program);
  await program.parseAsync(['node', 'bridge', ...args]);
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  (outputSuccess as jest.Mock).mockReset();
  (outputError as jest.Mock).mockReset();
  process.exitCode = undefined;
});
afterAll(() => {
  process.exitCode = undefined;
});

describe('parseDotenv', () => {
  it('reads KEY=VALUE, export, quotes and trailing comments; skips comments and junk', () => {
    expect(parseDotenv([
      '# comment', 'A=1', 'export B="two words"', "C='x#y'", 'D=plain # note', 'not a line', '',
    ].join('\n'))).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'plain' });
  });
});

describe('what bridge diagnose sends', () => {
  it('only Bridge variables, and a secret as presence only', () => {
    expect(bridgeEnvToSend({
      VITE_BRIDGE_APP_ID: 'app_1', BRIDGE_API_KEY: SECRET, VITE_BRIDGE_API_KEY: SECRET,
      EMPTY_BRIDGE_SECRET: '', DATABASE_URL: 'postgres://u:p@h/db',
    })).toEqual({ VITE_BRIDGE_APP_ID: 'app_1', BRIDGE_API_KEY: SECRET_PLACEHOLDER, VITE_BRIDGE_API_KEY: SECRET_PLACEHOLDER });
  });

  it('reads the project .env files (later wins), detects the framework, and never sends a secret value', async () => {
    post.mockResolvedValue({ ok: false, differences: [{ code: 'APP_ID_MISMATCH', fix: 'Set VITE_BRIDGE_APP_ID=app_1.' }] });
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { svelte: '^5.0.0' } }),
      '.env': `VITE_BRIDGE_APP_ID=old\nBRIDGE_API_KEY=${SECRET}\n`,
      '.env.local': 'VITE_BRIDGE_APP_ID=app_local\n',
    });

    const result = await diagnose({ dir });

    expect(post).toHaveBeenCalledWith('/v1/account/integration/diagnose', {
      env: { VITE_BRIDGE_APP_ID: 'app_local', BRIDGE_API_KEY: SECRET_PLACEHOLDER },
      framework: 'svelte',
    });
    expect(JSON.stringify(post.mock.calls)).not.toContain(SECRET);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      differences: [{ code: 'APP_ID_MISMATCH', hint: 'Set VITE_BRIDGE_APP_ID=app_1.' }],
      envFilesRead: ['.env', '.env.local'],
      secretsSentAsPresenceOnly: ['BRIDGE_API_KEY'],
    }));
  });

  it('--env-file names a file that must exist', async () => {
    const dir = project({});
    await expect(diagnose({ dir, envFile: ['.env.production'] })).rejects.toMatchObject({ code: 'ENV_FILE_NOT_FOUND' });
    expect(post).not.toHaveBeenCalled();
  });

  it('the command exits non-zero when differences are found', async () => {
    post.mockResolvedValue({ ok: false, differences: [] });
    const dir = project({ '.env': 'BRIDGE_APP_ID=x\n' });
    await run('diagnose', '--dir', dir, '--framework', 'nestjs');
    expect(outputSuccess).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('the other commands', () => {
  it('setup status reads the checklist and renames fix to hint', async () => {
    get.mockResolvedValue({ items: [{ id: 'redirect_uris', status: 'missing', nextStep: 'x' }], productionNeeds: [] });
    await run('setup', 'status');
    expect(get).toHaveBeenCalledWith('/v1/account/integration/status');
  });

  it('test-user create passes --confirm through only when given', async () => {
    post.mockResolvedValue({ email: 'bridge-test-1@example.com' });
    await run('test-user', 'create');
    await run('test-user', 'create', '--confirm', 'Acme');
    expect(post.mock.calls).toEqual([
      ['/v1/account/integration/test-user', {}],
      ['/v1/account/integration/test-user', { confirm: 'Acme' }],
    ]);
  });

  it('test-user verify prints the evidence and exits non-zero when sign-in failed', async () => {
    post.mockResolvedValue({ verified: false, failure: { code: 'WRONG_PASSWORD', message: 'm', fix: 'reset it' } });
    await run('test-user', 'verify', '--email', 'a@b.c', '--password', 'pw');
    expect(post).toHaveBeenCalledWith('/v1/account/integration/verify-login', { email: 'a@b.c', password: 'pw' });
    expect(outputSuccess).toHaveBeenCalledWith({ verified: false, failure: { code: 'WRONG_PASSWORD', message: 'm', hint: 'reset it' } });
    expect(process.exitCode).toBe(1);
  });

  it('event auth-attempts sends user, since and limit', async () => {
    get.mockResolvedValue({ attempts: [] });
    await run('event', 'auth-attempts', '--user', 'jane+x@acme.test', '--since', '7d', '--limit', '5');
    expect(get).toHaveBeenCalledWith('/v1/account/integration/auth-attempts?user=jane%2Bx%40acme.test&since=7d&limit=5');
  });

  it('fixToHint renames at every depth and leaves everything else alone', () => {
    expect(fixToHint({ fix: 'a', items: [{ fix: 'b', fixed: 1 }], n: null })).toEqual({ hint: 'a', items: [{ hint: 'b', fixed: 1 }], n: null });
  });
});

/*
 * TBP-540 (folds TBP-599) — `bridge diagnose` (alias `bridge doctor`) says so
 * when a Bridge plugin is installed and nothing calls it.
 */
describe('a Bridge plugin that nothing calls', () => {
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-wiring-'));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }
  const SVELTE_PKG = JSON.stringify({ dependencies: { '@sveltejs/kit': '^2', '@nebulr-group/bridge-svelte': '^0.6.0' } });

  it('is reported with the guides that wire it, and fails the diagnosis', async () => {
    post.mockResolvedValue({ ok: true, differences: [] });
    const dir = tree({
      'package.json': SVELTE_PKG,
      // The TBP-599 shape: a hand-written login against a guessed endpoint.
      'src/routes/login/+page.svelte': '<script>fetch(`${api}/auth/login`, { method: "POST" })</script>',
      // A match inside node_modules must not count as wiring.
      'node_modules/@nebulr-group/bridge-svelte/index.js': 'export function bridgeBootstrap() {}',
    });

    const result = await diagnose({ dir });

    expect(result.ok).toBe(false);
    expect(result.pluginWiring).toEqual([
      expect.objectContaining({ framework: 'svelte', package: '@nebulr-group/bridge-svelte', wired: false }),
    ]);
    const [wiring] = result.pluginWiring as Array<{ hint: string }>;
    expect(wiring.hint).toContain('bridgeBootstrap()');
    expect(wiring.hint).toContain('`bridge guide svelte sdk-auth`');
  });

  it('is quiet once the bootstrap call exists', async () => {
    post.mockResolvedValue({ ok: true, differences: [] });
    const dir = tree({
      'package.json': SVELTE_PKG,
      'src/routes/+layout.ts': "import { bridgeBootstrap } from '@nebulr-group/bridge-svelte';\nexport const load = bridgeBootstrap({});\n",
    });

    const result = await diagnose({ dir });

    expect(result.ok).toBe(true);
    expect(result.pluginWiring).toEqual([{ framework: 'svelte', package: '@nebulr-group/bridge-svelte', wired: true }]);
  });

  it('checks each installed plugin, and says nothing for a project without one', async () => {
    const dir = tree({
      'package.json': JSON.stringify({ dependencies: { '@nebulr-group/bridge-nestjs': '1', '@nebulr-group/bridge-react': '1' } }),
      'src/app.module.ts': 'imports: [BridgeModule.forRoot({})]',
    });
    expect(await checkPluginWiring(dir)).toEqual([
      expect.objectContaining({ framework: 'react', wired: false, hint: expect.stringContaining('`bridge guide react sdk-auth`') }),
      { framework: 'nestjs', package: '@nebulr-group/bridge-nestjs', wired: true },
    ]);
    expect(await checkPluginWiring(tree({ 'package.json': '{"dependencies":{"svelte":"5"}}' }))).toEqual([]);
  });

  it('`bridge doctor` runs the same check', async () => {
    post.mockResolvedValue({ ok: true, differences: [] });
    const dir = tree({ 'package.json': SVELTE_PKG });
    await run('doctor', '--dir', dir);
    expect(outputSuccess).toHaveBeenCalledWith(expect.objectContaining({ ok: false, pluginWiring: [expect.objectContaining({ wired: false })] }));
    expect(process.exitCode).toBe(1);
  });
});
