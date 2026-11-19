/**
 * Before a command reaches Bridge, one line on stderr says which server and app it acts on, so a write never lands on
 * another app unannounced. stdout stays the result alone.
 */
import { createFakeBridge, type FakeBridge, ISSUER } from './helpers/fake-bridge';
import { createCli } from './helpers/run';
import { DEFAULT_SERVER, issuerSource } from '../config';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const banners = (infos: string[]) => infos.filter((line) => line.startsWith('bridge: '));

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
});
afterEach(() => cli.cleanup());

describe('the line before a command', () => {
  it('names the app, the server and what chose each, once per command', async () => {
    await cli.run(['app', 'use', appId]);
    const done = await cli.run(['key', 'list']);
    expect(banners(done.infos)).toEqual([`bridge: acting on app Demo (${appId}) · ${new URL(ISSUER).origin} · app from the app chosen with \`bridge app use\`, server from BRIDGE_ISSUER`]);
  });

  it('says --app and BRIDGE_APP when they chose the app', async () => {
    await cli.run(['app', 'use', appId]);
    const other = fake.addApp({ name: 'Other', owner: 'ws-1' });
    expect(banners((await cli.run(['key', 'list', '--app', other])).infos)[0]).toContain(`acting on app ${other} ·`);
    expect(banners((await cli.run(['key', 'list', '--app', other])).infos)[0]).toContain('app from --app');
    expect(banners((await cli.run(['key', 'list'], { env: { BRIDGE_APP: other } })).infos)[0]).toContain('app from BRIDGE_APP');
  });

  it('a command with no app names the server only', async () => {
    const done = await cli.run(['app', 'list']);
    expect(banners(done.infos)).toEqual([`bridge: ${new URL(ISSUER).origin} · server from BRIDGE_ISSUER`]);
    // The names of the listed apps are remembered for the next line.
    await cli.run(['app', 'use', appId]);
    expect(banners((await cli.run(['key', 'list'])).infos)[0]).toContain(`Demo (${appId})`);
  });

  it('goes to stderr only: the result is untouched, and BRIDGE_NO_BANNER silences it', async () => {
    await cli.run(['app', 'use', appId]);
    const done = await cli.run(['key', 'list'], { env: { BRIDGE_NO_BANNER: 'true' } });
    expect(banners(done.infos)).toEqual([]);
    expect(done.errors).toEqual([]);
    expect(Array.isArray(done.data)).toBe(true);
  });

  it('is not printed when the command stops before it reaches Bridge', async () => {
    const done = await cli.run(['key', 'list'], { env: { BRIDGE_APP: '' } });
    expect(banners(done.infos)).toEqual([]);
    expect(done.error).toMatchObject({ code: 'misconfigured' });
  });
});

describe('which server a command goes to', () => {
  it('is what was given, else what sign-in saved, else Bridge\'s production server, and says which', () => {
    expect(issuerSource({ issuer: 'https://a.example/identity-access/apps/x' }, {}, {})).toMatchObject({ from: '--issuer' });
    expect(issuerSource({ server: 'https://a.example' }, { BRIDGE_SERVER: 'https://b.example' }, {})).toEqual({ server: 'https://a.example', from: '--server' });
    expect(issuerSource({}, { BRIDGE_ISSUER: 'https://b.example/identity-access/apps/x' }, {})).toMatchObject({ from: 'BRIDGE_ISSUER' });
    expect(issuerSource({}, { BRIDGE_SERVER: 'https://b.example' }, {})).toEqual({ server: 'https://b.example', from: 'BRIDGE_SERVER' });
    expect(issuerSource({}, {}, { issuer: 'https://c.example/identity-access/apps/x' })).toMatchObject({ from: 'the sign-in saved on this machine' });
    expect(issuerSource({}, { BRIDGE_ISSUER: ' ' }, {})).toEqual({ server: DEFAULT_SERVER, from: "the default, Bridge's production server" });
    expect(DEFAULT_SERVER).toBe('https://api.thebridge.dev');
  });
});
