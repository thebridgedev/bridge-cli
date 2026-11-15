/** `bridge app setup`: points the developer's project at the app on the Bridge the CLI signed in to. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnvValue } from '../setup/env-file';
import { BASE, createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let project: string;
let appId: string;

const issuerOf = (id: string, base = BASE) => `${base}/identity-access/apps/${id}`;

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  (fake.apps.get(appId) as Record<string, unknown>)['trust'] = { issuer: issuerOf(appId), audience: BASE };
  expect((await cli.run(['app', 'use', appId])).errors).toEqual([]);
  project = mkdtempSync(join(tmpdir(), 'bridge-cli-project-'));
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
  rmSync(project, { recursive: true, force: true });
});

describe('app setup', () => {
  it('writes the app\'s issuer into .env and adds the dev address as a browser origin and email-links page', async () => {
    const envFile = join(project, '.env');
    writeFileSync(envFile, 'OTHER=kept\nPUBLIC_BRIDGE_ISSUER=https://old.example/identity-access/apps/x\n# a comment\n');
    const done = await cli.run(['app', 'setup', '--dotenv', envFile]);
    expect(done.errors).toEqual([]);
    expect(readFileSync(envFile, 'utf8')).toBe(`OTHER=kept\nPUBLIC_BRIDGE_ISSUER=${issuerOf(appId)}\n# a comment\n`);
    expect(done.data).toEqual({
      app: { id: appId, name: 'Demo' },
      issuer: issuerOf(appId),
      envFile,
      variable: 'PUBLIC_BRIDGE_ISSUER',
      added: [
        { url: 'http://localhost:5173', use: 'browser-origin' },
        { url: 'http://localhost:5173/auth', use: 'email-links' },
      ],
    });
    expect((fake.apps.get(appId) as { addresses: unknown[] }).addresses).toEqual([
      { url: 'http://localhost:5173', uses: ['browser-origin'] },
      { url: 'http://localhost:5173/auth', uses: ['email-links'] },
    ]);
    // A second run changes nothing.
    const again = await cli.run(['app', 'setup', '--dotenv', envFile]);
    expect(again.data.added).toEqual([]);
    expect(again.infos[0]).toMatch(/^Kept PUBLIC_BRIDGE_ISSUER=/);
  });

  it('makes the .env file when there is none, with another address, page and variable', async () => {
    const envFile = join(project, '.env.local');
    const done = await cli.run(['app', 'setup', '--dotenv', envFile, '--url', 'https://app.example.com', '--auth-path', '/login/', '--var', 'VITE_BRIDGE_ISSUER']);
    expect(done.errors).toEqual([]);
    expect(readFileSync(envFile, 'utf8')).toBe(`VITE_BRIDGE_ISSUER=${issuerOf(appId)}\n`);
    expect(done.data.added).toEqual([
      { url: 'https://app.example.com', use: 'browser-origin' },
      { url: 'https://app.example.com/login', use: 'email-links' },
    ]);
  });

  it('refuses an app whose issuer is on another Bridge than the one signed in to, and writes nothing', async () => {
    (fake.apps.get(appId) as Record<string, unknown>)['trust'] = { issuer: issuerOf(appId, 'https://other-bridge.example'), audience: BASE };
    const envFile = join(project, '.env');
    const done = await cli.run(['app', 'setup', '--dotenv', envFile]);
    expect(done.error).toMatchObject({ code: 'misconfigured' });
    expect(() => readFileSync(envFile, 'utf8')).toThrow();
    expect((fake.apps.get(appId) as { addresses: unknown[] }).addresses).toEqual([]);
  });

  it('refuses a dev address that is not an origin, and an app with no issuer', async () => {
    for (const url of ['http://example.com', 'https://app.example.com/path', 'ftp://app.example.com']) {
      expect((await cli.run(['app', 'setup', '--dotenv', join(project, '.env'), '--url', url])).error).toMatchObject({ code: 'invalid' });
    }
    (fake.apps.get(appId) as Record<string, unknown>)['trust'] = null;
    expect((await cli.run(['app', 'setup', '--dotenv', join(project, '.env')])).error).toMatchObject({ code: 'misconfigured' });
  });
});

describe('withEnvValue', () => {
  it('replaces the first line that sets the name, drops later ones, keeps the rest, and appends when missing', () => {
    expect(withEnvValue('', 'A', '1')).toBe('A=1\n');
    expect(withEnvValue('B=2', 'A', '1')).toBe('B=2\nA=1\n');
    expect(withEnvValue('export A=0\r\nB=2\nA=9\n', 'A', '1')).toBe('A=1\nB=2\n');
    expect(withEnvValue('AB=2\n', 'A', '1')).toBe('AB=2\nA=1\n');
    expect(() => withEnvValue('', 'A B', '1')).toThrow();
  });
});
