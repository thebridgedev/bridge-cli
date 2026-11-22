/**
 * The "Your app" settings and the mode (TBP-871, TBP-872) on the version 2 routes the pinned contract lists: the main
 * address with the passkeys a move stops, where users sign in, and development or production with the rules production
 * keeps on.
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const last = (method: string, part: string) => fake.requests.filter((r) => r.method === method && r.path.includes(part)).pop();
const origins = (...urls: string[]) => urls.map((url) => ({ url, uses: ['browser-origin'] }));

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  fake.setYourApp(appId, { mode: 'production', main: 'https://acme.com', addresses: origins('https://acme.com', 'https://app.acme.io') });
  await cli.run(['app', 'use', appId]);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('app create', () => {
  it('sends the mode and the main address, which Bridge lists', async () => {
    const done = await cli.run(['app', 'create', '--name', 'Acme dev', '--mode', 'development', '--main', 'http://localhost:5173']);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/v2/app-registry/apps')?.body).toMatchObject({ name: 'Acme dev', mode: 'development', main: 'http://localhost:5173' });
    expect(done.data).toMatchObject({ yourApp: { mode: 'development', main: 'http://localhost:5173' } });
  });

  it('refuses a mode that is neither', async () => {
    expect((await cli.run(['app', 'create', '--name', 'X', '--mode', 'staging'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('app main', () => {
  it('shows the main address, the passkey domain and what it can be moved to', async () => {
    expect((await cli.run(['app', 'main'])).data).toEqual({ main: 'https://acme.com', passkeyDomain: 'acme.com', choices: ['https://acme.com', 'https://app.acme.io'] });
  });

  it('shows how many passkeys stop working and changes nothing without --confirm-passkeys', async () => {
    fake.setPasskeys(appId, 38);
    const done = await cli.run(['app', 'main', 'https://app.acme.io']);
    expect(done.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('38 passkeys would stop working') });
    expect(done.infos.join(' ')).toContain('stops 38 passkeys made for acme.com');
    expect(last('PATCH', '/v2/app-registry/apps/')).toBeUndefined();
  });

  it('moves it on --confirm-passkeys, and says how many stopped', async () => {
    fake.setPasskeys(appId, 38);
    const done = await cli.run(['app', 'main', 'https://app.acme.io', '--confirm-passkeys']);
    expect(done.errors).toEqual([]);
    expect(last('PATCH', '/v2/app-registry/apps/')?.body).toEqual({ main: 'https://app.acme.io', confirmPasskeys: true });
    expect(done.data).toMatchObject({ main: 'https://app.acme.io', changed: true, passkeysStopped: 38 });
  });

  it('moves it with no confirmation when the domain stays', async () => {
    fake.setYourApp(appId, { mode: 'production', main: 'https://acme.com', addresses: origins('https://acme.com', 'https://app.acme.com') });
    const done = await cli.run(['app', 'main', 'https://app.acme.com']);
    expect(done.errors).toEqual([]);
    expect(last('PATCH', '/v2/app-registry/apps/')?.body).toEqual({ main: 'https://app.acme.com' });
    expect(done.data).toMatchObject({ passkeysStopped: 0 });
  });

  it('shows Bridge\'s refusal of an address the app does not list', async () => {
    const done = await cli.run(['app', 'main', 'https://other.example']);
    expect(done.error).toBeDefined();
  });
});

describe('app sign-in', () => {
  it('shows where users sign in, and changes only what is given', async () => {
    expect((await cli.run(['app', 'sign-in'])).data.signIn).toMatchObject({ location: 'hosted', path: '/auth/login', returnPath: '/auth/oauth-callback' });
    const done = await cli.run(['app', 'sign-in', '--location', 'app', '--email-links', 'hosted']);
    expect(last('PATCH', '/v2/app-registry/apps/')?.body).toEqual({ signIn: { location: 'app', emailLinks: 'hosted' } });
    expect(done.data.signIn).toMatchObject({ location: 'app', emailLinks: 'hosted' });
    await cli.run(['app', 'sign-in', '--email-links', 'default', '--path', '/login']);
    expect(last('PATCH', '/v2/app-registry/apps/')?.body).toEqual({ signIn: { path: '/login', emailLinks: null } });
  });

  it('refuses a place that is neither', async () => {
    expect((await cli.run(['app', 'sign-in', '--location', 'cloud'])).error).toMatchObject({ code: 'invalid' });
  });
});

describe('app mode', () => {
  beforeEach(() => {
    fake.setYourApp(appId, { mode: 'development', main: 'http://localhost:5173', addresses: origins('http://localhost:5173') });
  });

  it('shows the mode and the rules; the password rule is checked when users sign in when Bridge cannot say', async () => {
    const done = await cli.run(['app', 'mode']);
    expect(done.data).toMatchObject({ mode: 'development', usersToChooseNewPassword: 0, canSwitchToProduction: false });
    expect(done.data.rules).toEqual([
      { rule: 'main-address-is-a-real-website', text: 'Main address is a real website', passes: false },
      { rule: 'password-rules-at-least-recommended', text: 'Password rules at least Recommended', passes: true },
    ]);
  });

  it('refuses the switch to production while a rule fails, and changes nothing', async () => {
    const done = await cli.run(['app', 'mode', 'production', '--yes']);
    expect(done.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('Main address is a real website') });
    expect(last('POST', '/mode')).toBeUndefined();
  });

  it('refuses a password rule that fails too', async () => {
    fake.setYourApp(appId, { mode: 'development', main: 'https://acme-demo.com', addresses: origins('https://acme-demo.com') });
    fake.setProduction(appId, { passes: false, users: 1 });
    const done = await cli.run(['app', 'mode', 'production', '--yes']);
    expect(done.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('Password rules at least Recommended') });
  });

  it('needs --yes, and says how many users must choose a new password', async () => {
    fake.setYourApp(appId, { mode: 'development', main: 'https://acme-demo.com', addresses: origins('https://acme-demo.com') });
    fake.setProduction(appId, { passes: true, users: 12 });
    const asked = await cli.run(['app', 'mode', 'production']);
    expect(asked.error).toMatchObject({ code: 'invalid', message: expect.stringContaining('needs a confirmation') });
    expect(asked.infos.join(' ')).toContain('12 users with a password that breaks the production rules must choose a new one');
    expect(last('POST', '/mode')).toBeUndefined();
    const done = await cli.run(['app', 'mode', 'production', '--yes']);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/mode')?.body).toEqual({ mode: 'production', confirm: true });
    expect(done.data).toMatchObject({ mode: 'production', switched: { from: 'development', to: 'production' } });
  });

  it('switches back to development after a confirmation, nothing loosened', async () => {
    fake.setYourApp(appId, { mode: 'production', main: 'https://acme-demo.com', addresses: origins('https://acme-demo.com') });
    expect((await cli.run(['app', 'mode', 'development'])).error).toMatchObject({ code: 'invalid' });
    const done = await cli.run(['app', 'mode', 'development', '--yes']);
    expect(done.data).toMatchObject({ mode: 'development', switched: { from: 'production', to: 'development' } });
  });

  it('says so when the app is in that mode already, and refuses another word', async () => {
    expect((await cli.run(['app', 'mode', 'development'])).infos.join(' ')).toContain('in development already');
    expect((await cli.run(['app', 'mode', 'staging'])).error).toMatchObject({ code: 'invalid' });
  });
});
