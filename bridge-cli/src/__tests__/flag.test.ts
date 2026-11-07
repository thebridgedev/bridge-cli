/** Flags and their rules: every change names the revision it was made on (If-Match). */
import { parseCondition } from '../api/flags';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

describe('parseCondition', () => {
  it('reads "<attribute> <operator> <value>"', () => {
    expect(parseCondition('privileges contains USER_WRITE')).toEqual({ attribute: 'privileges', operator: 'contains', values: ['USER_WRITE'] });
    expect(parseCondition('bridge:billing.entitlement.analytics eq true')).toEqual({ attribute: 'bridge:billing.entitlement.analytics', operator: 'eq', values: [true] });
    expect(parseCondition('user.email in a@example.com, b@example.com')).toEqual({ attribute: 'user.email', operator: 'in', values: ['a@example.com', 'b@example.com'] });
    expect(parseCondition('account.age between 10,20')).toEqual({ attribute: 'account.age', operator: 'between', values: [10, 20] });
    expect(parseCondition('user.id exists')).toEqual({ attribute: 'user.id', operator: 'exists', values: [] });
    expect(parseCondition('user.name eq "Ada Lovelace"')).toEqual({ attribute: 'user.name', operator: 'eq', values: ['Ada Lovelace'] });
    expect(() => parseCondition('user.role is ADMIN')).toThrow(/not an operator/);
    expect(() => parseCondition('user.role eq')).toThrow(/needs a value/);
    expect(() => parseCondition('a between 1')).toThrow(/two values/);
  });
});

describe('flag commands', () => {
  let fake: FakeBridge;
  let cli: ReturnType<typeof createCli>;
  let appId: string;
  const flagRequests = (method: string) => fake.requests.filter((r) => r.method === method && r.path.includes('/flags'));
  const last = (method: string) => flagRequests(method).pop();

  beforeEach(async () => {
    fake = createFakeBridge();
    fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
    cli = createCli(fake);
    await cli.signIn();
    appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
    await cli.run(['app', 'use', appId]);
  });
  afterEach(() => {
    expect(fake.violations).toEqual([]);
    cli.cleanup();
  });

  it('create: a boolean flag, off, by default', async () => {
    const done = await cli.run(['flag', 'create', 'new-dashboard', '--description', 'The new dashboard']);
    expect(done.errors).toEqual([]);
    expect(last('POST')?.body).toEqual({ key: 'new-dashboard', valueType: 'boolean', onValue: true, offValue: false, state: 'off', description: 'The new dashboard' });
  });

  it('create with --when: a one-branch rule, running', async () => {
    await cli.run(['flag', 'create', 'analytics', '--when', 'bridge:billing.entitlement.analytics eq true', '--when', 'privileges contains REPORTS_READ', '--rollout', '50']);
    expect(last('POST')?.body).toMatchObject({
      key: 'analytics',
      state: 'on-with-rule',
      rule: {
        branches: [
          {
            conditions: [
              { attribute: 'bridge:billing.entitlement.analytics', operator: 'eq', values: [true] },
              { attribute: 'privileges', operator: 'contains', values: ['REPORTS_READ'] },
            ],
            returnValue: true,
            rolloutPct: 50,
          },
        ],
        otherwiseValue: false,
      },
    });
  });

  it('create a string flag needs its values; --rule takes JSON', async () => {
    expect((await cli.run(['flag', 'create', 'theme', '--type', 'string'])).error).toMatchObject({ code: 'invalid' });
    const rule = JSON.stringify({ branches: [{ conditions: [{ attribute: 'user.email', operator: 'regex', values: ['@example\\.com$'] }], returnValue: 'dark' }], otherwiseValue: 'light' });
    await cli.run(['flag', 'create', 'theme', '--type', 'string', '--on-value', 'dark', '--off-value', 'light', '--rule', rule]);
    expect(last('POST')?.body).toMatchObject({ valueType: 'string', onValue: 'dark', offValue: 'light', state: 'on-with-rule', rule: JSON.parse(rule) });
    expect((await cli.run(['flag', 'create', 'bad', '--rule', '{"branches": 3}'])).error).toMatchObject({ code: 'invalid' });
  });

  it('update reads the flag and sends its revision in If-Match', async () => {
    await cli.run(['flag', 'create', 'beta']);
    await cli.run(['flag', 'update', 'beta', '--description', 'Beta features', '--public']);
    const patch = last('PATCH');
    expect(patch?.headers['if-match']).toBe('"1"');
    expect(patch?.body).toEqual({ description: 'Beta features', public: true });
    await cli.run(['flag', 'update', 'beta', '--state', 'on']);
    expect(last('PATCH')?.headers['if-match']).toBe('"2"');
    expect((await cli.run(['flag', 'update', 'beta'])).error).toMatchObject({ code: 'invalid', message: 'Nothing to change.' });
  });

  it('update with --when sets the rule and runs it', async () => {
    await cli.run(['flag', 'create', 'beta']);
    await cli.run(['flag', 'on', 'beta']);
    await cli.run(['flag', 'update', 'beta', '--when', 'user.email in a@example.com,b@example.com']);
    expect(last('PATCH')?.body).toMatchObject({ state: 'on-with-rule', rule: { branches: [{ returnValue: true }], otherwiseValue: false } });
  });

  it('on / off / restore', async () => {
    await cli.run(['flag', 'create', 'beta', '--when', 'user.id exists']);
    expect((await cli.run(['flag', 'off', 'beta'])).data.state).toBe('off');
    expect(last('POST')?.path).toBe(`/v2/flags/apps/${appId}/flags/beta/kill`);
    expect((await cli.run(['flag', 'restore', 'beta'])).data.state).toBe('on-with-rule');
    expect((await cli.run(['flag', 'on', 'beta'])).data.state).toBe('on');
    expect(last('PATCH')?.body).toEqual({ state: 'on' });
  });

  it('rule add appends a branch (or puts it first), rule set replaces, rule clear removes', async () => {
    await cli.run(['flag', 'create', 'reports', '--state', 'on']);
    await cli.run(['flag', 'rule', 'add', 'reports', '--when', 'privileges contains REPORTS_READ']);
    await cli.run(['flag', 'rule', 'add', 'reports', '--when', 'user.email eq boss@example.com', '--first']);
    const shown = await cli.run(['flag', 'rule', 'show', 'reports']);
    expect(shown.data.state).toBe('on-with-rule');
    expect(shown.data.rule.branches.map((b: { conditions: { attribute: string }[] }) => b.conditions[0]?.attribute)).toEqual(['user.email', 'privileges']);
    expect(shown.data.rule.otherwiseValue).toBe(false);

    await cli.run(['flag', 'rule', 'set', 'reports', '--rule', JSON.stringify({ branches: [], otherwiseValue: true })]);
    expect(last('PATCH')?.body).toEqual({ rule: { branches: [], otherwiseValue: true }, state: 'on-with-rule' });
    await cli.run(['flag', 'rule', 'clear', 'reports']);
    expect(last('PATCH')?.body).toEqual({ rule: null, state: 'on' });
  });

  it('a rule added to a switched-off flag leaves it off, and says how to turn it on', async () => {
    await cli.run(['flag', 'create', 'quiet']);
    const done = await cli.run(['flag', 'rule', 'add', 'quiet', '--when', 'user.id exists']);
    expect(done.data.state).toBe('off');
    expect(done.infos.join('\n')).toContain('bridge flag restore quiet');
  });

  it('delete needs --yes and names the revision', async () => {
    await cli.run(['flag', 'create', 'gone']);
    expect((await cli.run(['flag', 'delete', 'gone'])).error).toMatchObject({ code: 'usage' });
    await cli.run(['flag', 'delete', 'gone', '--yes']);
    expect(last('DELETE')?.headers['if-match']).toBe('"1"');
    expect((await cli.run(['flag', 'list'])).data).toEqual([]);
  });
});
