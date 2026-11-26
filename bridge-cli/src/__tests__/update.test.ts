/**
 * The CLI says when a newer version is out on its own line, at most once a day, on stderr after the command's output,
 * never slowing it; and `bridge update` updates it with the package manager that installed it, or prints the command.
 * The registry is a real local server: no test reaches the network.
 */
import * as http from 'node:http';
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { UpdateDeps } from '../commands/context';
import { detectInstall, updatePlan } from '../core/install';
import { compareVersions, DAY_MS, lineOf, noticeText } from '../core/updates';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

interface Registry {
  url: string;
  hits: string[];
  tags: Record<string, string>;
  delayMs: number;
  close: () => Promise<void>;
}

async function serveRegistry(tags: Record<string, string>): Promise<Registry> {
  const registry = { hits: [] as string[], tags, delayMs: 0 } as Registry;
  const server = http.createServer((req, res) => {
    registry.hits.push(req.url ?? '');
    const answer = () => {
      if (req.url !== '/-/package/@nebulr-group%2fbridge-cli/dist-tags') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(registry.tags));
    };
    if (registry.delayMs > 0) setTimeout(answer, registry.delayMs).unref();
    else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  registry.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return registry;
}

const GLOBAL_NPM = '/usr/local/lib/node_modules/@nebulr-group/bridge-cli/dist/cli.js';
const NOTICE = /^A newer Bridge CLI is out: /;

let fake: FakeBridge;
let registry: Registry;
let clock: number;
let runs: { command: string; args: readonly string[] }[];
let exitOfRun: number;

function updates(extra: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    registry: registry.url,
    installPath: GLOBAL_NPM,
    run: async (command, args) => {
      runs.push({ command, args });
      return exitOfRun;
    },
    ...extra,
  };
}

/** A signed-in CLI at a version, with an empty update cache and no registry hits yet. */
async function cliAt(version: string, extra: Partial<UpdateDeps> = {}, env: Record<string, string> = {}) {
  const cli = createCli(fake, { version, updates: updates(extra), now: () => clock, env });
  await cli.signIn();
  rmSync(join(cli.dir, 'update-check.json'), { force: true });
  registry.hits.length = 0;
  return cli;
}

const clis: { cleanup: () => void }[] = [];
async function tracked(version: string, extra: Partial<UpdateDeps> = {}, env: Record<string, string> = {}) {
  const cli = await cliAt(version, extra, env);
  clis.push(cli);
  return cli;
}

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  fake.addApp({ name: 'Demo', owner: 'ws-1' });
  registry = await serveRegistry({ latest: '0.6.7', beta: '0.6.2-beta.0', alpha: '1.0.0-alpha.6' });
  clock = 1_900_000_000_000;
  runs = [];
  exitOfRun = 0;
});
afterEach(async () => {
  clis.splice(0).forEach((cli) => cli.cleanup());
  await registry.close();
});

describe('the line and the order of versions', () => {
  it('a prerelease follows alpha, anything else latest', () => {
    expect(lineOf('1.0.0-alpha.5')).toBe('alpha');
    expect(lineOf('1.0.0')).toBe('latest');
    expect(lineOf('1.2.3')).toBe('latest');
  });

  it('orders versions as semver does', () => {
    expect(compareVersions('1.0.0-alpha.5', '1.0.0-alpha.6')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha.6', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('0.6.7', '1.0.0-alpha.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('not a version', '1.0.0')).toBe(0);
  });
});

describe('the notice', () => {
  it('says a newer alpha is out, on stderr, after the command output; stdout and the exit code are unchanged', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const done = await cli.run(['app', 'list']);
    const quiet = await cli.run(['app', 'list'], { env: { BRIDGE_NO_UPDATE_NOTICE: 'true' } });
    expect(done.infos[done.infos.length - 1]).toBe(noticeText('1.0.0-alpha.5', '1.0.0-alpha.6'));
    expect(done.infos[done.infos.length - 1]).toBe('A newer Bridge CLI is out: 1.0.0-alpha.6 (you have 1.0.0-alpha.5). Run: bridge update');
    expect(done.order[done.order.length - 1]).toMatch(/^err:A newer Bridge CLI is out/);
    expect(done.order.indexOf('out:result')).toBeLessThan(done.order.length - 1);
    expect(done.results).toEqual(quiet.results);
    expect(done.exitCode).toBe(0);
    expect(registry.hits).toEqual(['/-/package/@nebulr-group%2fbridge-cli/dist-tags']);
  });

  it('is printed at most once a day, and the registry is asked at most once a day', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toHaveLength(1);
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toHaveLength(0);
    clock += DAY_MS - 1;
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toHaveLength(0);
    expect(registry.hits).toHaveLength(1);
    clock += 2;
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toHaveLength(1);
    expect(registry.hits).toHaveLength(2);
  });

  it('keeps what it saw in a file only its owner may read', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    await cli.run(['app', 'list']);
    const file = join(cli.dir, 'update-check.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ line: 'alpha', seen: '1.0.0-alpha.6', checkedAt: clock, notifiedAt: clock });
    if (process.platform !== 'win32') expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it('says nothing when the version is the newest or newer', async () => {
    for (const version of ['1.0.0-alpha.6', '1.0.0-alpha.7']) {
      const cli = await tracked(version);
      const done = await cli.run(['app', 'list']);
      expect(done.infos.filter((line) => NOTICE.test(line))).toEqual([]);
      expect(registry.hits).toHaveLength(1);
    }
  });

  it('a stable version follows latest and is never told about an alpha', async () => {
    registry.tags = { latest: '1.0.0', alpha: '1.0.1-alpha.3' };
    const stable = await tracked('1.0.0');
    expect((await stable.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toEqual([]);
    registry.tags = { latest: '1.0.1', alpha: '1.0.2-alpha.0' };
    const older = await tracked('1.0.0');
    expect((await older.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toEqual(['A newer Bridge CLI is out: 1.0.1 (you have 1.0.0). Run: bridge update']);
  });

  it('BRIDGE_NO_UPDATE_NOTICE=true switches it off: nothing printed, the registry not asked', async () => {
    const cli = await tracked('1.0.0-alpha.5', {}, { BRIDGE_NO_UPDATE_NOTICE: 'true' });
    const done = await cli.run(['app', 'list']);
    expect(done.infos.filter((line) => NOTICE.test(line))).toEqual([]);
    expect(registry.hits).toEqual([]);
    expect(existsSync(join(cli.dir, 'update-check.json'))).toBe(false);
  });

  it('an unreachable registry prints nothing and the command is unchanged', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    await registry.close();
    const done = await cli.run(['app', 'list']);
    expect(done.infos.filter((line) => NOTICE.test(line))).toEqual([]);
    expect(done.exitCode).toBe(0);
    expect(Array.isArray(done.data)).toBe(true);
    registry = await serveRegistry({ alpha: '1.0.0-alpha.6' });
  });

  it('a slow registry prints nothing and does not hold the command up', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    registry.delayMs = 5_000;
    const started = Date.now();
    const done = await cli.run(['app', 'list']);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(done.infos.filter((line) => NOTICE.test(line))).toEqual([]);
    expect(done.exitCode).toBe(0);
    // Nothing was saved, so the next command asks again.
    registry.delayMs = 0;
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toHaveLength(1);
  });

  it('a registry answering an error or nonsense prints nothing', async () => {
    registry.tags = { alpha: 'not-a-version' } as Record<string, string>;
    const cli = await tracked('1.0.0-alpha.5');
    expect((await cli.run(['app', 'list'])).infos.filter((line) => NOTICE.test(line))).toEqual([]);
  });

  it('without a terminal: nothing is asked, and a failing command keeps its error and exit code, with the notice after', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const asked: string[] = [];
    const failing = await cli.run(['key', 'list'], { env: { BRIDGE_APP: '' }, interactive: false, answers: asked });
    const quiet = await cli.run(['key', 'list'], { env: { BRIDGE_APP: '', BRIDGE_NO_UPDATE_NOTICE: 'true' } });
    expect(failing.exitCode).toBe(quiet.exitCode);
    expect(failing.exitCode).not.toBe(0);
    expect(failing.errors).toEqual(quiet.errors);
    expect(failing.results).toEqual([]);
    expect(failing.order[failing.order.length - 1]).toMatch(/^err:A newer Bridge CLI is out/);
  });

  it('a cache file that is a symlink is not followed, and the command still works', async () => {
    if (process.platform === 'win32') return;
    const cli = await tracked('1.0.0-alpha.5');
    const target = join(cli.dir, 'elsewhere.json');
    writeFileSync(target, '{}');
    symlinkSync(target, join(cli.dir, 'update-check.json'));
    const done = await cli.run(['app', 'list']);
    expect(done.exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('is not printed by `bridge update` itself', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const done = await cli.run(['update']);
    expect(done.infos.filter((line) => NOTICE.test(line))).toEqual([]);
  });
});

describe('how the CLI was installed', () => {
  it.each([
    ['/usr/local/lib/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'npm' }],
    ['/Users/dev/.nvm/versions/node/v22.1.0/lib/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'npm' }],
    ['C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@nebulr-group\\bridge-cli\\dist\\cli.js', undefined, { kind: 'global', manager: 'npm' }],
    ['/Users/dev/Library/pnpm/global/5/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'pnpm' }],
    ['/home/dev/.local/share/pnpm/global/5/.pnpm/@nebulr-group+bridge-cli@1.0.0-alpha.5/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'pnpm' }],
    ['/home/dev/.config/yarn/global/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'yarn' }],
    ['/home/dev/.bun/install/global/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'global', manager: 'bun' }],
    ['/home/dev/.npm/_npx/4f3a/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'npm/10.8.0 node/v22.1.0 darwin arm64', { kind: 'npx' }],
    ['/work/app/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'npm/10.8.0 node/v22.1.0', { kind: 'local', manager: 'npm' }],
    ['/work/app/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'yarn/1.22.22 npm/? node/v22.1.0', { kind: 'local', manager: 'yarn' }],
    ['/work/app/node_modules/.pnpm/@nebulr-group+bridge-cli@1.0.0-alpha.5/node_modules/@nebulr-group/bridge-cli/dist/cli.js', undefined, { kind: 'local', manager: 'pnpm' }],
    ['/work/app/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'bun/1.1.0', { kind: 'local', manager: 'bun' }],
    ['/src/bridge-cli/bridge-cli/dist/cli.js', undefined, { kind: 'unknown' }],
  ])('%s (%s)', (path, agent, install) => {
    expect(detectInstall(path, agent)).toEqual(install);
  });

  it('the command for each, on the line', () => {
    expect(updatePlan({ kind: 'global', manager: 'npm' }, 'alpha').text).toBe('npm install -g @nebulr-group/bridge-cli@alpha');
    expect(updatePlan({ kind: 'global', manager: 'pnpm' }, 'latest').text).toBe('pnpm add -g @nebulr-group/bridge-cli@latest');
    expect(updatePlan({ kind: 'global', manager: 'yarn' }, 'alpha').text).toBe('yarn global add @nebulr-group/bridge-cli@alpha');
    expect(updatePlan({ kind: 'global', manager: 'bun' }, 'alpha').text).toBe('bun add -g @nebulr-group/bridge-cli@alpha');
    expect(updatePlan({ kind: 'npx' }, 'alpha')).toMatchObject({ runnable: false, text: 'npx @nebulr-group/bridge-cli@alpha' });
    expect(updatePlan({ kind: 'local', manager: 'pnpm' }, 'alpha')).toMatchObject({ runnable: false, text: 'pnpm add @nebulr-group/bridge-cli@alpha' });
    expect(updatePlan({ kind: 'unknown' }, 'latest')).toMatchObject({ runnable: false, text: 'npm install -g @nebulr-group/bridge-cli@latest' });
  });
});

describe('bridge update', () => {
  it('in a terminal, asks, then runs the package manager on the same line', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const done = await cli.run(['update'], { interactive: true, answers: ['y'] });
    expect(runs).toEqual([{ command: 'npm', args: ['install', '-g', '@nebulr-group/bridge-cli@alpha'] }]);
    expect(done.data).toMatchObject({ current: '1.0.0-alpha.5', line: 'alpha', newest: '1.0.0-alpha.6', install: 'global', ran: true });
    expect(done.exitCode).toBe(0);
  });

  it('in a terminal, a no changes nothing', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const done = await cli.run(['update'], { interactive: true, answers: ['n'] });
    expect(runs).toEqual([]);
    expect(done.data).toMatchObject({ ran: false });
  });

  it('without a terminal, never asks: prints the command, or runs it with --yes', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    const printed = await cli.run(['update'], { interactive: false });
    expect(runs).toEqual([]);
    expect(printed.infos.join('\n')).toContain('Run: npm install -g @nebulr-group/bridge-cli@alpha');
    expect(printed.data).toMatchObject({ ran: false, command: 'npm install -g @nebulr-group/bridge-cli@alpha' });
    expect(printed.exitCode).toBe(0);
    const ran = await cli.run(['update', '--yes'], { interactive: false });
    expect(runs).toHaveLength(1);
    expect(ran.data).toMatchObject({ ran: true });
  });

  it.each([
    ['/Users/dev/Library/pnpm/global/5/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'pnpm', ['add', '-g', '@nebulr-group/bridge-cli@latest']],
    ['/home/dev/.config/yarn/global/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'yarn', ['global', 'add', '@nebulr-group/bridge-cli@latest']],
    ['/home/dev/.bun/install/global/node_modules/@nebulr-group/bridge-cli/dist/cli.js', 'bun', ['add', '-g', '@nebulr-group/bridge-cli@latest']],
  ])('a stable global %s install updates with %s on latest', async (installPath, command, args) => {
    registry.tags = { latest: '1.0.1', alpha: '1.1.0-alpha.0' };
    const cli = await tracked('1.0.0', { installPath });
    await cli.run(['update', '--yes']);
    expect(runs).toEqual([{ command, args }]);
  });

  it('through npx or as a project dependency, prints the command and runs nothing', async () => {
    const npx = await tracked('1.0.0-alpha.5', { installPath: '/home/dev/.npm/_npx/4f3a/node_modules/@nebulr-group/bridge-cli/dist/cli.js' });
    const viaNpx = await npx.run(['update', '--yes'], { interactive: true });
    expect(viaNpx.data).toMatchObject({ install: 'npx', ran: false, command: 'npx @nebulr-group/bridge-cli@alpha' });
    const local = await tracked('1.0.0-alpha.5', { installPath: '/work/app/node_modules/@nebulr-group/bridge-cli/dist/cli.js' }, { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.1.0' });
    const viaProject = await local.run(['update', '--yes']);
    expect(viaProject.data).toMatchObject({ install: 'local', ran: false, command: 'pnpm add @nebulr-group/bridge-cli@alpha' });
    expect(viaProject.infos.join('\n')).toContain('Run: pnpm add @nebulr-group/bridge-cli@alpha');
    expect(runs).toEqual([]);
  });

  it('says so and runs nothing when already the newest', async () => {
    const cli = await tracked('1.0.0-alpha.6');
    const done = await cli.run(['update', '--yes']);
    expect(runs).toEqual([]);
    expect(done.data).toMatchObject({ upToDate: true, ran: false });
  });

  it('with the registry unreachable, still runs the package manager on the line', async () => {
    const cli = await tracked('1.0.0-alpha.5');
    await registry.close();
    const done = await cli.run(['update', '--yes']);
    expect(runs).toEqual([{ command: 'npm', args: ['install', '-g', '@nebulr-group/bridge-cli@alpha'] }]);
    expect(done.data).toMatchObject({ newest: null, ran: true });
    registry = await serveRegistry({});
  });

  it('a failing package manager is an error with its exit code', async () => {
    exitOfRun = 243;
    const cli = await tracked('1.0.0-alpha.5');
    const done = await cli.run(['update', '--yes']);
    expect(done.error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('exit code 243') });
    expect(done.exitCode).not.toBe(0);
  });
});
