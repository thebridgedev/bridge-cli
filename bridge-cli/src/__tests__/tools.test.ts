/**
 * Assistants and CLI (TBP-852, TBP-853, TBP-854) on the version 2 routes the pinned contract lists: `app tools`, the
 * extra MCP endpoints (`app mcp`), and a user's connected tools for the app's admins.
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
  fake.setYourApp(appId, { mode: 'production', main: 'https://acme.com', addresses: [{ url: 'https://acme.com', uses: ['browser-origin'] }] });
  await cli.run(['app', 'use', appId]);
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('app tools', () => {
  it('shows the defaults: any assistant, no short code, browser and MCP sign-in always on', async () => {
    const shown = await cli.run(['app', 'tools']);
    expect(shown.errors).toEqual([]);
    expect(shown.data).toEqual({ tools: { anyAssistant: true, assistants: [], shortCode: false, browserSignIn: 'always on', mcpSignIn: 'always on' } });
  });

  it('allows only listed assistants and switches short codes on, with the phishing warning', async () => {
    const done = await cli.run(['app', 'tools', 'set', '--any-assistant', 'off', '--assistant', 'claude', 'https://agent.example.com/client.json', '--short-code', 'on']);
    expect(done.errors).toEqual([]);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ tools: { anyAssistant: false, assistants: ['claude', 'https://agent.example.com/client.json'], shortCode: true } });
    expect(done.infos.join(' ')).toContain('device code phishing');
    expect(done.data.tools).toMatchObject({ anyAssistant: false, assistants: [{ id: 'claude', name: 'Claude' }, { id: 'https://agent.example.com/client.json', name: 'https://agent.example.com/client.json' }], shortCode: true });
    // A change merges into what the app has.
    await cli.run(['app', 'tools', 'set', '--short-code', 'off']);
    expect(last('PATCH', '/sign-in-settings')?.body).toEqual({ tools: { shortCode: false } });
    expect((await cli.run(['app', 'tools'])).data.tools).toMatchObject({ anyAssistant: false, shortCode: false });
  });

  it('refuses what Bridge would refuse, before anything is sent', async () => {
    expect((await cli.run(['app', 'tools', 'set'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['app', 'tools', 'set', '--short-code', 'maybe'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['app', 'tools', 'set', '--assistant', 'http://agent.example.com/c.json'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('https') });
    expect(last('PATCH', '/sign-in-settings')).toBeUndefined();
  });

  it('says an older server has no such settings', async () => {
    fake.beOlderServer();
    expect((await cli.run(['app', 'tools'])).error).toMatchObject({ code: 'not-offered' });
    expect((await cli.run(['app', 'mcp', 'list'])).error).toMatchObject({ code: 'not-offered' });
  });
});

describe('app mcp', () => {
  it('adds, lists and removes an MCP endpoint on another domain', async () => {
    expect((await cli.run(['app', 'mcp', 'list'])).data).toEqual({ mcp: [] });
    const added = await cli.run(['app', 'mcp', 'add', 'https://mcp.other-domain.com/mcp']);
    expect(added.errors).toEqual([]);
    expect(last('PATCH', `/apps/${appId}`)?.body).toEqual({ mcp: ['https://mcp.other-domain.com/mcp'] });
    expect(added.data).toEqual({ mcp: ['https://mcp.other-domain.com/mcp'], changed: true });
    expect((await cli.run(['app', 'mcp', 'list'])).data).toEqual({ mcp: ['https://mcp.other-domain.com/mcp'] });
    expect((await cli.run(['app', 'mcp', 'remove', 'https://mcp.other-domain.com/mcp'])).data).toEqual({ mcp: [], changed: true });
    expect((await cli.run(['app', 'mcp', 'remove', 'https://mcp.other-domain.com/mcp'])).error).toMatchObject({ code: 'not-found' });
  });

  it("needs nothing for the app's own addresses, and refuses what is not one https URL", async () => {
    const own = await cli.run(['app', 'mcp', 'add', 'https://acme.com/mcp']);
    expect(own.data).toEqual({ mcp: [], changed: false });
    expect(own.infos.join(' ')).toContain('need nothing');
    for (const bad of ['http://mcp.other.com/mcp', 'https://*.other.com/mcp', 'https://mcp.other.com/mcp?x=1', 'https://mcp.other.com/mcp#a']) {
      expect((await cli.run(['app', 'mcp', 'add', bad])).error).toMatchObject({ code: 'invalid' });
    }
    expect(last('PATCH', `/apps/${appId}`)).toBeUndefined();
  });
});

describe("a user's connected tools", () => {
  beforeEach(() => {
    fake.addUser(appId, { id: 'user-1', email: 'anna@acme.example' });
    fake.userConnections(appId, 'user-1').push(
      { id: 's-1', kind: 'assistant', client: { id: 'claude', name: 'Claude' }, workspace: 'Marketing', delete: false, signedInAt: '2026-11-20T00:00:00.000Z', lastUsedAt: '2026-11-26T00:00:00.000Z', expiresAt: null },
      { id: 's-2', kind: 'cli', client: { id: appId, name: 'CLI' }, workspace: null, delete: true, signedInAt: '2026-11-21T00:00:00.000Z', lastUsedAt: null, expiresAt: null },
    );
    fake.setBrowserSessions(appId, 'user-1', 2);
  });

  it('lists them by email or user id', async () => {
    const listed = await cli.run(['user', 'connections', 'anna@acme.example']);
    expect(listed.errors).toEqual([]);
    expect(listed.data).toEqual({
      user: 'anna@acme.example',
      connections: [
        { id: 's-1', name: 'Claude', kind: 'assistant', workspace: 'Marketing', connectedAt: '2026-11-20T00:00:00.000Z', lastUsedAt: '2026-11-26T00:00:00.000Z', mayDelete: false },
        { id: 's-2', name: 'CLI', kind: 'command-line tool', workspace: null, connectedAt: '2026-11-21T00:00:00.000Z', lastUsedAt: null, mayDelete: true },
      ],
    });
    // `users` is the same group.
    expect((await cli.run(['users', 'connections', 'user-1'])).data.connections).toHaveLength(2);
  });

  it('disconnects one with --yes, and all with --all', async () => {
    expect((await cli.run(['user', 'disconnect', 'user-1', 's-1'])).error).toMatchObject({ code: 'invalid', message: expect.stringContaining('--yes') });
    expect((await cli.run(['user', 'disconnect', 'user-1', 's-1', '--dry-run'])).data).toMatchObject({ dryRun: true, connections: [{ id: 's-1', name: 'Claude' }] });
    expect(fake.userConnections(appId, 'user-1')).toHaveLength(2);
    expect((await cli.run(['user', 'disconnect', 'user-1', 's-1', '--yes'])).data).toMatchObject({ disconnected: 1, connections: [{ id: 's-1' }] });
    expect(last('DELETE', '/users/user-1/connections/s-1')).toBeDefined();
    expect((await cli.run(['user', 'disconnect', 'user-1', 's-1', '--yes'])).error).toMatchObject({ code: 'not-found' });
    expect((await cli.run(['user', 'disconnect', 'user-1'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['user', 'disconnect', 'anna@acme.example', '--all', '--yes'])).data).toMatchObject({ disconnected: 1 });
    expect(fake.userConnections(appId, 'user-1')).toHaveLength(0);
    expect(fake.browserSessions(appId, 'user-1')).toBe(2);
  });

  it('signs the user out everywhere with --yes', async () => {
    expect((await cli.run(['user', 'sign-out-everywhere', 'user-1'])).error).toMatchObject({ code: 'invalid' });
    expect(fake.browserSessions(appId, 'user-1')).toBe(2);
    const done = await cli.run(['users', 'sign-out-everywhere', 'anna@acme.example', '--yes']);
    expect(done.data).toEqual({ signedOut: true, ended: 4, user: 'anna@acme.example' });
    expect(last('DELETE', '/users/user-1/sessions')).toBeDefined();
    expect(fake.browserSessions(appId, 'user-1')).toBe(0);
  });

  it('says an older server does not list them', async () => {
    fake.beOlderServer();
    expect((await cli.run(['user', 'connections', 'user-1'])).error).toMatchObject({ code: 'not-offered' });
  });
});
