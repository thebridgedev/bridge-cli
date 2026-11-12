/**
 * The CLI against a real Bridge (TBP-935, C01): a developer signs in and sets up the same Child App the dashboard suites use: an address, a flag, a role.
 *
 * Needs, all by environment and never printed: PARITY_ISSUER (the Bridge App's issuer), PARITY_DEVELOPER_EMAIL and PARITY_DEVELOPER_PASSWORD (the developer who owns
 * the app) and PARITY_APP_ID (the Child App). Without them the file is skipped. Run it with `npm run test:parity`.
 *
 * It signs in with the password, which is what `bridge auth login --password` is for. The browser hand-off through the hosted page is proved at the page
 * (apps/sign-in's e2e) and waits for the hand-off return binding before it can be driven here end to end.
 */
import { randomBytes } from 'node:crypto';
import type { FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

const { PARITY_ISSUER, PARITY_DEVELOPER_EMAIL, PARITY_DEVELOPER_PASSWORD, PARITY_APP_ID } = process.env;
const configured = [PARITY_ISSUER, PARITY_DEVELOPER_EMAIL, PARITY_DEVELOPER_PASSWORD, PARITY_APP_ID].every((value) => (value ?? '') !== '');
const suite = configured ? describe : describe.skip;

suite('the CLI sets up the parity app on a real Bridge', () => {
  // The CLI's own fetch against the real deployment; createCli takes only the clock from this stand-in.
  const cli = createCli({ fetch, now: () => Date.now() } as unknown as FakeBridge, { env: { BRIDGE_ISSUER: String(PARITY_ISSUER) } });
  const options = { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) };
  const run = (args: string[], extra: Record<string, unknown> = {}) => cli.run(args, { ...options, ...extra });
  const tag = randomBytes(3).toString('hex');
  const flagKey = `parity-cli-${tag}`;
  const roleKey = `PARITY_CLI_${tag.toUpperCase()}`;
  const origin = `https://parity-cli-${tag}.example.test`;

  afterAll(() => cli.cleanup());

  it('signs in with the developer\'s password, in their workspace', async () => {
    const done = await run(['auth', 'login', '--password', '--email', String(PARITY_DEVELOPER_EMAIL), '--password-stdin'], { stdin: `${String(PARITY_DEVELOPER_PASSWORD)}\n` });
    expect(done.exitCode, JSON.stringify(done.errors)).toBe(0);
    expect(done.infos.join(' ')).toContain('Signed in as');
  });

  it('chooses the parity app and reads it back', async () => {
    const used = await run(['app', 'use', String(PARITY_APP_ID)]);
    expect(used.exitCode, JSON.stringify(used.errors)).toBe(0);
    const got = await run(['app', 'get']);
    expect(got.exitCode, JSON.stringify(got.errors)).toBe(0);
    expect(got.output).toContain(String(PARITY_APP_ID));
  });

  it('adds an address and lists it, then removes it', async () => {
    const added = await run(['app', 'address', 'add', origin, '--use', 'browser-origin']);
    expect(added.exitCode, JSON.stringify(added.errors)).toBe(0);
    expect((await run(['app', 'address', 'list'])).output).toContain(origin);
    const removed = await run(['app', 'address', 'remove', origin]);
    expect(removed.exitCode, JSON.stringify(removed.errors)).toBe(0);
    expect((await run(['app', 'address', 'list'])).output).not.toContain(origin);
  });

  it('makes a flag, switches it on, reads it back, and deletes it', async () => {
    const made = await run(['flag', 'create', flagKey, '--description', 'Made by the parity CLI test', '--state', 'off']);
    expect(made.exitCode, JSON.stringify(made.errors)).toBe(0);
    try {
      const on = await run(['flag', 'on', flagKey]);
      expect(on.exitCode, JSON.stringify(on.errors)).toBe(0);
      const got = await run(['flag', 'get', flagKey]);
      expect(got.exitCode, JSON.stringify(got.errors)).toBe(0);
      expect(got.output).toMatch(/"state":\s*"on"/);
      expect((await run(['flag', 'list'])).output).toContain(flagKey);
    } finally {
      const gone = await run(['flag', 'delete', flagKey, '--yes']);
      expect(gone.exitCode, JSON.stringify(gone.errors)).toBe(0);
    }
  });

  it('makes a role with a privilege the app has, lists it, and deletes it', async () => {
    const made = await run(['role', 'create', roleKey, '--name', 'Parity CLI role', '--privilege', 'parity.reports:read']);
    expect(made.exitCode, JSON.stringify(made.errors)).toBe(0);
    try {
      expect((await run(['role', 'list'])).output).toContain(roleKey);
    } finally {
      const gone = await run(['role', 'delete', roleKey]);
      expect(gone.exitCode, JSON.stringify(gone.errors)).toBe(0);
    }
  });
});
