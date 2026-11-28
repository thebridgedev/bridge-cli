/**
 * `bridge auth login --device`: sign-in with a short code (RFC 8628) on a machine without a browser. The CLI asks for a
 * code, prints the address and the code, and polls the token endpoint (honouring the interval and slow_down) until the
 * developer approves on another device; denied and expired codes stop it with a clear message. The session is kept as
 * a browser sign-in's.
 */
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;

beforeEach(() => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  fake.setSignInPage('https://bridge.test/sign-in/bridge-app/');
  fake.setDeviceCodes(true);
  cli = createCli(fake);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

const polls = () => fake.requests.filter((r) => r.path.endsWith('/token') && (r.body as Record<string, unknown>)['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code');

describe('auth login --device', () => {
  it('prints the address and the code, polls until approved, and is signed in as a browser sign-in is', async () => {
    fake.onDevicePoll((code, n) => {
      if (n === 2) fake.approveDevice(code, 'dev@example.com');
    });
    const started = fake.now();
    const done = await cli.run(['auth', 'login', '--device']);
    expect(done.errors).toEqual([]);
    expect(done.infos).toContain('Open https://dashboard.test/connect/device/ and enter WDJB-MJHT. The code expires in 10 minutes.');
    expect(done.infos).toContain('Or open https://dashboard.test/connect/device/?code=WDJB-MJHT to have the code filled in.');
    expect(done.infos).toContain('Signed in as dev@example.com.');
    expect(done.data).toMatchObject({ issuer: ISSUER, workspace: 'ws-1', user: { email: 'dev@example.com' } });
    expect(fake.requests.find((r) => r.path.endsWith('/device-authorization'))?.body).toEqual({ client_id: 'bridge-app' });
    expect(polls().map((r) => r.body)).toEqual([
      { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: expect.stringMatching(/^dc-/), client_id: 'bridge-app' },
      { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: expect.stringMatching(/^dc-/), client_id: 'bridge-app' },
    ]);
    // Every poll waited the interval Bridge gave (5 s).
    expect(fake.now() - started).toBe(10_000);
    // Kept as the browser sign-in keeps it: the next command works.
    expect((await cli.run(['auth', 'whoami'])).errors).toEqual([]);
  });

  it('waits 5 seconds longer after slow_down', async () => {
    fake.onDevicePoll((code, n) => {
      if (n === 1) fake.slowDownDevice(code);
      if (n === 3) fake.approveDevice(code, 'dev@example.com');
    });
    const started = fake.now();
    const done = await cli.run(['auth', 'login', '--device']);
    expect(done.errors).toEqual([]);
    // The first poll after 5 s is answered slow_down; every later one waits 10 s.
    expect(fake.now() - started).toBe(5_000 + 10_000 + 10_000);
  });

  it('stops when the sign-in was denied, or the code expired', async () => {
    fake.onDevicePoll((code) => fake.denyDevice(code));
    const denied = await cli.run(['auth', 'login', '--device']);
    expect(denied.error).toMatchObject({ message: 'The sign-in was not approved.' });
    expect(denied.exitCode).toBe(1);

    fake.onDevicePoll(null);
    const expired = await cli.run(['auth', 'login', '--device']);
    expect(expired.error).toMatchObject({ message: 'The code expired. Run `bridge auth login --device` again.' });
    expect(expired.exitCode).toBe(1);
    expect((await cli.run(['auth', 'whoami'])).errors).not.toEqual([]);
  });

  it('says when Bridge does not offer sign-in with a code', async () => {
    fake.setDeviceCodes(false);
    const done = await cli.run(['auth', 'login', '--device']);
    expect(done.error).toMatchObject({ message: 'This Bridge does not offer sign-in with a code; use a browser, or an app key for scripts and CI.' });
    expect(fake.requests.some((r) => r.path.endsWith('/device-authorization'))).toBe(false);
  });

  it('suggests --device when no browser can be opened, where Bridge offers it; the browser sign-in is otherwise as before', async () => {
    const done = await cli.run(['auth', 'login'], { openBrowser: async () => ({ ok: false }) });
    // No browser opened and nobody comes back: the loopback times out, after the hint.
    expect(done.infos).toContain('No browser on this machine? Run `bridge auth login --device` instead.');
    fake.setDeviceCodes(false);
    const without = await cli.run(['auth', 'login'], { openBrowser: async () => ({ ok: false }) });
    expect(without.infos.join('\n')).not.toContain('--device');
  }, 20_000);

  it('is one way to sign in: not with --password', async () => {
    expect((await cli.run(['auth', 'login', '--device', '--password'])).error).toMatchObject({ code: 'invalid' });
  });
});
