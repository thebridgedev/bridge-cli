/**
 * Login security (TBP-84, TBP-83, TBP-85, TBP-87): suspend and resume with a reason, blocked domains (the app's and a
 * workspace's), the workspaces one person can create, Sign-up protection with its flagged sign-ups, leaked passwords and
 * admin notices: each on the version 2 routes the contract lists.
 */
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;
const last = (method: string, part: string) => fake.requests.filter((r) => r.method === method && r.path.includes(part)).pop();

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  await cli.run(['app', 'use', appId]);
  fake.addUser(appId, { id: 'u1', email: 'ada@example.com' });
  fake.addUser(appId, { id: 'u2', email: 'x1@mailinator.com' });
  fake.addUser(appId, { id: 'u3', email: 'x2@Mailinator.com' });
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('suspending a person (TBP-84)', () => {
  it('suspends by email with a reason, and shows who, when and why', async () => {
    const done = await cli.run(['user', 'suspend', '--email', 'ada@example.com', '--reason', 'Chargeback fraud']);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/users/u1/suspend')?.body).toEqual({ reason: 'Chargeback fraud' });
    expect(done.data).toMatchObject({ id: 'u1', suspended: true, changed: true, suspension: { by: 'a team member', reason: 'Chargeback fraud' } });
    const shown = await cli.run(['user', 'suspension', '--email', 'ada@example.com']);
    expect(shown.data).toMatchObject({ suspended: true, suspension: { reason: 'Chargeback fraud', by: 'a team member' } });
    expect(shown.data.suspension.at).toMatch(/^20/);
  });

  it('suspends by user id without a reason, sending an empty body, and wants exactly one way to name the person', async () => {
    await cli.run(['user', 'suspend', '--user-id', 'u2']);
    expect(last('POST', '/users/u2/suspend')?.body).toEqual({});
    expect((await cli.run(['user', 'suspend'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'suspend', '--email', 'a@b.co', '--user-id', 'u2'])).error).toMatchObject({ code: 'invalid' });
  });

  it('resumes, and says when the person is not found', async () => {
    await cli.run(['user', 'suspend', '--user-id', 'u1', '--reason', 'x']);
    const back = await cli.run(['user', 'resume', '--email', 'ada@example.com']);
    expect(back.data).toMatchObject({ id: 'u1', suspended: false, changed: true });
    expect(back.data.suspension).toBeUndefined();
    expect((await cli.run(['user', 'suspension', '--email', 'nobody@example.com'])).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['user', 'suspend', '--email', 'nobody@example.com'])).error).toMatchObject({ code: 'not-found' });
  });

  it('refuses a reason over 500 characters before calling Bridge', async () => {
    const done = await cli.run(['user', 'suspend', '--user-id', 'u1', '--reason', 'x'.repeat(501)]);
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(last('POST', '/suspend')).toBeUndefined();
  });
});

describe('blocked domains (TBP-84)', () => {
  it('says how many people are on the domain, blocks it, and keeps their access unless asked', async () => {
    const done = await cli.run(['domain', 'block', 'Mailinator.com', '--reason', 'Throwaway']);
    expect(done.errors).toEqual([]);
    expect(done.infos.join(' ')).toContain('2 people in this app use mailinator.com; 2 not suspended yet.');
    expect(done.infos.join(' ')).toContain('Add --suspend-existing');
    expect(last('POST', '/domain-blocks')?.body).toEqual({ domain: 'mailinator.com', reason: 'Throwaway', suspendExisting: false });
    expect(done.data).toMatchObject({ domain: 'mailinator.com', peopleOnDomain: 2, suspended: 0, changed: true });
    expect((await cli.run(['user', 'suspension', '--email', 'x1@mailinator.com'])).data.suspended).toBe(false);
  });

  it('suspends the people already on it with --suspend-existing, each marked with the domain', async () => {
    const done = await cli.run(['domain', 'block', 'x@mailinator.com', '--suspend-existing']);
    expect(last('POST', '/domain-blocks')?.body).toEqual({ domain: 'mailinator.com', suspendExisting: true });
    expect(done.data).toMatchObject({ suspended: 2 });
    expect((await cli.run(['user', 'suspension', '--email', 'x1@mailinator.com'])).data).toMatchObject({ suspended: true, suspension: { viaDomain: 'mailinator.com' } });
  });

  it('lists with who blocked each, and unblocks', async () => {
    await cli.run(['domain', 'block', 'mailinator.com', '--reason', 'Throwaway']);
    const listed = await cli.run(['domain', 'list']);
    expect(listed.data.blocked).toEqual([expect.objectContaining({ domain: 'mailinator.com', by: 'a team member', reason: 'Throwaway' })]);
    const gone = await cli.run(['domain', 'unblock', 'mailinator.com']);
    expect(gone.data).toMatchObject({ domain: 'mailinator.com', changed: true });
    expect((await cli.run(['domain', 'list'])).data.blocked).toEqual([]);
  });

  it('refuses what is not a domain before calling Bridge', async () => {
    const done = await cli.run(['domain', 'block', 'not a domain']);
    expect(done.error).toMatchObject({ code: 'invalid' });
    expect(last('POST', '/domain-blocks')).toBeUndefined();
  });

  it('keeps a workspace\'s own list apart from the app\'s, and never suspends from it', async () => {
    const done = await cli.run(['domain', 'block', 'rival.com', '--workspace', 'ws-9', '--reason', 'Competitor']);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/workspaces/ws-9/domain-blocks')?.body).toEqual({ domain: 'rival.com', reason: 'Competitor' });
    expect(done.data).toMatchObject({ workspace: 'ws-9', changed: true });
    expect((await cli.run(['domain', 'list'])).data.blocked).toEqual([]);
    expect((await cli.run(['domain', 'list', '--workspace', 'ws-9'])).data.blocked).toEqual([expect.objectContaining({ domain: 'rival.com' })]);
    expect((await cli.run(['domain', 'block', 'x.com', '--workspace', 'ws-9', '--suspend-existing'])).error).toMatchObject({ code: 'invalid' });
    await cli.run(['domain', 'unblock', 'rival.com', '--workspace', 'ws-9']);
    expect((await cli.run(['domain', 'list', '--workspace', 'ws-9'])).data.blocked).toEqual([]);
  });
});

describe('workspaces one person can create (TBP-87)', () => {
  it('shows the setting, sets a number or none', async () => {
    expect((await cli.run(['workspace', 'limit'])).data).toEqual({ workspacesPerPerson: null });
    expect((await cli.run(['workspace', 'limit', '3'])).data).toEqual({ workspacesPerPerson: 3, changed: true });
    expect(last('PUT', '/workspace-limit')?.body).toEqual({ workspacesPerPerson: 3 });
    expect((await cli.run(['workspace', 'limit', 'none'])).data).toEqual({ workspacesPerPerson: null, changed: true });
    expect(last('PUT', '/workspace-limit')?.body).toEqual({ workspacesPerPerson: null });
  });

  it('refuses anything but a whole number from 1, or none, before calling Bridge', async () => {
    for (const bad of ['0', '1.5', 'two', '1e3']) expect((await cli.run(['workspace', 'limit', bad])).error).toMatchObject({ code: 'invalid' });
    expect(last('PUT', '/workspace-limit')).toBeUndefined();
  });
});

describe('sign-up protection and flagged sign-ups (TBP-83)', () => {
  it('shows the setting (Watch by default) and changes it', async () => {
    expect((await cli.run(['auth', 'sign-up-protection'])).data).toEqual({ signUpProtection: 'watch' });
    const done = await cli.run(['auth', 'sign-up-protection', 'block']);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ signUpProtection: 'block' });
    expect(done.data).toEqual({ signUpProtection: 'block', changed: true });
    expect((await cli.run(['auth', 'sign-up-protection'])).data).toEqual({ signUpProtection: 'block' });
    expect((await cli.run(['auth', 'sign-up-protection', 'strict'])).error).toMatchObject({ code: 'invalid' });
  });

  it('lists the flagged sign-ups with score and the reasons in words', async () => {
    fake.addFlagged(appId, { user: 'u2', email: 'x1@mailinator.com', score: 100, reasons: ['throwaway_domain', 'hidden_field_filled'] });
    fake.addFlagged(appId, { user: 'u3', email: 'g+7@gmail.com', score: 40, reasons: ['address_variation'] });
    const listed = await cli.run(['auth', 'flagged-sign-ups']);
    expect(listed.data.signUps).toEqual([
      expect.objectContaining({ email: 'x1@mailinator.com', score: 100, reasons: ['Throwaway email domain', 'A hidden field was filled in'] }),
      expect.objectContaining({ email: 'g+7@gmail.com', score: 40, reasons: ['A variation of an address that already has a login'] }),
    ]);
    const strong = await cli.run(['auth', 'flagged-sign-ups', '--min-score', '60', '--limit', '10']);
    expect(strong.data.signUps).toHaveLength(1);
    expect(last('GET', '/flagged-sign-ups')?.query.get('limit')).toBe('10');
  });
});

describe('sign-up numbers with and without the flagged ones (TBP-83)', () => {
  it('shows the last 30 days by default, and the days asked for', async () => {
    fake.setSignUps(appId, 12);
    fake.addFlagged(appId, { user: 'u2', email: 'x1@mailinator.com', score: 100, reasons: ['throwaway_domain'] });
    const counted = await cli.run(['auth', 'sign-up-counts']);
    expect(counted.errors).toEqual([]);
    expect(counted.data).toEqual({ days: 30, signUps: 12, flagged: 1, withoutFlagged: 11 });
    expect(last('GET', '/sign-up-counts')?.query.get('days')).toBe('30');
    expect((await cli.run(['auth', 'sign-up-counts', '--days', '7'])).data).toMatchObject({ days: 7 });
  });

  it('refuses days that are not a whole number from 1 to 365 before calling Bridge', async () => {
    for (const bad of ['0', '366', '1.5', 'week']) expect((await cli.run(['auth', 'sign-up-counts', '--days', bad])).error).toMatchObject({ code: 'invalid' });
    expect(last('GET', '/sign-up-counts')).toBeUndefined();
  });
});

describe('the support contact on the suspended message (TBP-84)', () => {
  it('sets an email address or an https address with the app\'s public details, and clears it with none', async () => {
    const set = await cli.run(['app', 'update', '--support-contact', ' support@acme-demo.com ']);
    expect(set.errors).toEqual([]);
    expect(last('PATCH', `/apps/${appId}`)?.body).toEqual({ supportContact: 'support@acme-demo.com' });
    expect(set.data.profile).toMatchObject({ supportContact: 'support@acme-demo.com' });
    await cli.run(['app', 'update', '--support-contact', 'https://acme-demo.com/help']);
    expect(last('PATCH', `/apps/${appId}`)?.body).toEqual({ supportContact: 'https://acme-demo.com/help' });
    await cli.run(['app', 'update', '--support-contact', 'none']);
    expect(last('PATCH', `/apps/${appId}`)?.body).toEqual({ supportContact: null });
  });

  it('refuses what a suspended person could not use, before calling Bridge', async () => {
    for (const bad of ['support', 'http://acme-demo.com', 'mailto:a@b.co', 'javascript:alert(1)']) {
      expect((await cli.run(['app', 'update', '--support-contact', bad])).error).toMatchObject({ code: 'invalid' });
    }
    expect(last('PATCH', `/apps/${appId}`)).toBeUndefined();
  });
});

describe('leaked passwords and admin notices (TBP-85)', () => {
  it('shows and changes the leaked-password setting (Warn by default)', async () => {
    expect((await cli.run(['auth', 'leaked-passwords'])).data).toEqual({ leakedPasswords: 'warn' });
    expect((await cli.run(['auth', 'leaked-passwords', 'refuse'])).data).toEqual({ leakedPasswords: 'refuse', changed: true });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ leakedPasswords: 'refuse' });
    expect((await cli.run(['auth', 'leaked-passwords', 'block'])).error).toMatchObject({ code: 'invalid' });
  });

  it('shows and switches admin notices (off by default), and auth config carries all three once Bridge has them', async () => {
    expect((await cli.run(['auth', 'admin-notices'])).data).toEqual({ adminNotices: false });
    expect((await cli.run(['auth', 'admin-notices', 'on'])).data).toEqual({ adminNotices: true, changed: true });
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ adminNotices: true });
    expect((await cli.run(['auth', 'admin-notices', 'maybe'])).error).toMatchObject({ code: 'invalid' });
    await cli.run(['auth', 'sign-up-protection', 'off']);
    expect((await cli.run(['auth', 'config'])).data).toMatchObject({ signUpProtection: 'off', adminNotices: true });
  });
});
