/**
 * TBP-708 — `bridge flag init` wires the project to the environment the CLI is
 * talking to, not to whatever the credentials file says.
 *
 * It used to re-read the credentials file for the base URL, which ignores
 * `BRIDGE_BASE_URL` and `--profile`. So a command that read the app from stage
 * wrote production into the project. This runs the REAL config resolution
 * (only the HTTP client is stubbed) and asserts on the file actually written.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const appGet = jest.fn().mockResolvedValue({ id: 'app_stage', name: 'Stage App' });
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn().mockImplementation(() => ({ app: { get: appGet } })),
  HttpError: class HttpError extends Error {},
}));

import { Command } from 'commander';
import { registerFlagInitCommand } from '../commands/flag-init.command';
import { resetManagementClient } from '../config';

const STAGE = 'https://api-stage.thebridge.dev';
const PROD = 'https://api.thebridge.dev';

describe('bridge flag init — base URL (TBP-708)', () => {
  const ORIGINAL_ENV = process.env;
  let home: string;
  let project: string;

  beforeEach(() => {
    resetManagementClient();
    process.env = { ...ORIGINAL_ENV, BRIDGE_NO_BANNER: 'true' };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_BASE_URL;
    delete process.env.BRIDGE_PROFILE;
    delete process.env.XDG_CONFIG_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-708-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-708-proj-'));
    process.env.HOME = home;
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { '@sveltejs/kit': '^2' } }));
    const dir = path.join(home, '.config', 'bridge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        apiKey: 'fake-jwt',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        issuedAt: new Date().toISOString(),
        app: { id: 'app_prod', name: 'Prod App' },
        user: { id: 'u1', email: 'dev@example.com' },
        baseUrl: PROD,
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
    resetManagementClient();
  });

  async function flagInit(...extra: string[]): Promise<{ written: Record<string, unknown>; stdout: string }> {
    let stdout = '';
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => ((stdout += String(c)), true));
    try {
      const program = new Command().exitOverride();
      registerFlagInitCommand(program.command('flag'));
      await program.parseAsync(['node', 'bridge', 'flag', 'init', '--cwd', project, ...extra]);
    } finally {
      spy.mockRestore();
    }
    return { written: JSON.parse(fs.readFileSync(path.join(project, 'bridge-flags.config.json'), 'utf8')), stdout };
  }

  it('writes the BRIDGE_BASE_URL environment, not the credentials file default', async () => {
    process.env.BRIDGE_BASE_URL = STAGE;
    const { written, stdout } = await flagInit();
    expect(written.baseUrl).toBe(STAGE);
    expect(stdout).toContain(STAGE);
    expect(stdout).not.toContain(PROD);
  });

  it('writes the signed-in environment when nothing overrides it', async () => {
    const { written } = await flagInit();
    expect(written.baseUrl).toBe(PROD);
  });

  it('still honours an explicit --base-url', async () => {
    process.env.BRIDGE_BASE_URL = STAGE;
    const { written } = await flagInit('--base-url', 'https://bridge.example.com');
    expect(written.baseUrl).toBe('https://bridge.example.com');
  });
});

describe('bridge flag init — existing config and the NestJS snippet (TBP-706)', () => {
  const ORIGINAL_ENV = process.env;
  let project: string;

  beforeEach(() => {
    resetManagementClient();
    process.env = { ...ORIGINAL_ENV, BRIDGE_NO_BANNER: 'true', BRIDGE_API_KEY: 'key', BRIDGE_BASE_URL: STAGE };
    delete process.env.BRIDGE_PROFILE;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-706-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-706-proj-'));
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^10' } }));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
    resetManagementClient();
  });

  async function run(...extra: string[]): Promise<string> {
    let out = '';
    const o = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => ((out += String(c)), true));
    const e = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => ((out += String(c)), true));
    try {
      const program = new Command().exitOverride();
      registerFlagInitCommand(program.command('flag'));
      await program.parseAsync(['node', 'bridge', 'flag', 'init', '--cwd', project, ...extra]);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    return out;
  }

  it('leaves an existing bridge-flags.config.json alone unless --force', async () => {
    const file = path.join(project, 'bridge-flags.config.json');
    fs.writeFileSync(file, '{"hand":"edited"}\n');
    const out = await run();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"hand":"edited"}\n');
    expect(out).toMatch(/already exists/);

    await run('--force');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).appId).toBe('app_stage');
  });

  it('puts the app id in appId, never in the API key slot', async () => {
    const out = await run();
    expect(out).toContain("appId: 'app_stage'");
    expect(out).not.toMatch(/apiKey: 'app_stage'/);
    expect(out).toContain('apiKey: process.env.BRIDGE_API_KEY');
  });
});
