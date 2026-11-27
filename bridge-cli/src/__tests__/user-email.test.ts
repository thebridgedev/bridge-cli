/**
 * An admin changes a User's sign-in address for someone who lost their inbox (TBP-835): `bridge user change-email`, on
 * Identity and Access's console route, behind a recent sign-in; an address a provider manages is refused with what to do.
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const posts = () => fake.requests.filter((r) => r.method === 'POST' && /\/users\/[^/]+\/email$/.test(r.path));

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  await cli.run(['app', 'use', appId]);
  fake.addUser(appId, { id: 'u1', email: 'anna@acme.test' });
  fake.addUser(appId, { id: 'u2', email: 'sam@acme.test', managedBy: 'google' });
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('bridge user change-email', () => {
  it('changes it by the person\'s current email, and says both addresses were told', async () => {
    const done = await cli.run(['user', 'change-email', 'Anna@NewMail.test', '--email', 'anna@acme.test']);
    expect(done.errors).toEqual([]);
    expect(posts().map((r) => [r.path, r.body])).toEqual([[`/v2/identity-access/apps/${appId}/users/u1/email`, { email: 'Anna@NewMail.test' }]]);
    expect(done.data).toEqual({ id: 'u1', previousEmail: 'anna@acme.test', email: 'anna@newmail.test', changed: true });
    expect(done.infos.join(' ')).toContain('Both addresses were told.');
    expect(fake.emailNotices).toEqual([
      { to: 'anna@acme.test', newEmail: 'anna@newmail.test' },
      { to: 'anna@newmail.test', newEmail: 'anna@newmail.test' },
    ]);
  });

  it('changes it by user id', async () => {
    const done = await cli.run(['user', 'change-email', 'anna@newmail.test', '--user-id', 'u1']);
    expect(done.data).toEqual({ id: 'u1', email: 'anna@newmail.test', changed: true });
  });

  it('wants a recent sign-in: an old one is `reauthenticate`, with how to go on', async () => {
    fake.advance(10 * 60 * 1000);
    const done = await cli.run(['user', 'change-email', 'anna@newmail.test', '--user-id', 'u1']);
    expect(done.error).toMatchObject({ code: 'reauthenticate' });
    expect(JSON.stringify(done.error)).toContain('bridge auth login');
  });

  it('an address Google manages is refused with what to do, and nothing changes', async () => {
    const done = await cli.run(['user', 'change-email', 'sam@new.test', '--email', 'sam@acme.test']);
    expect(done.error).toMatchObject({ code: 'conflict' });
    expect(JSON.stringify(done.error)).toContain('managed by Google');
    expect(fake.emailNotices).toEqual([]);
  });

  it('checks the address and who is named before calling Bridge', async () => {
    expect((await cli.run(['user', 'change-email', 'not-an-address', '--user-id', 'u1'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'change-email', 'anna@acme.test', '--email', 'anna@acme.test'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'change-email', 'a@b.test'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'change-email', 'a@b.test', '--email', 'nobody@acme.test'])).error).toMatchObject({ code: 'not-found' });
    expect(posts()).toEqual([]);
  });
});
