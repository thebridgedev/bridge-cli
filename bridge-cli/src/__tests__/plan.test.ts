/** Plans with prices, trials and per-unit usage prices, features and limits, as one /v2 document. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachUsage, parsePrice, parseUsagePrice, toMinor } from '../money';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

describe('money', () => {
  it('reads prices the way people write them, into minor units', () => {
    expect(parsePrice('19.99 EUR/month')).toEqual({ currency: 'EUR', interval: 'month', amount: 1999 });
    expect(parsePrice('190 eur/year')).toEqual({ currency: 'EUR', interval: 'year', amount: 19000 });
    expect(parsePrice('500 JPY/month')).toEqual({ currency: 'JPY', interval: 'month', amount: 500 });
    expect(parsePrice('49 USD')).toEqual({ currency: 'USD', interval: null, amount: 4900 });
    expect(toMinor('1.234', 'KWD')).toBe(1234);
    expect(() => parsePrice('19.999 EUR/month')).toThrow(/more decimals/);
    expect(() => parsePrice('5.5 JPY/month')).toThrow(/more decimals/);
    expect(() => parsePrice('19.99 EUR/fortnight')).toThrow(/not an interval/);
    expect(() => parsePrice('19.99')).toThrow(/A price is/);
  });

  it('reads usage prices into minor units as text, with no rounding', () => {
    expect(parseUsagePrice('api.calls 0.002 EUR/month included 10000')).toEqual({ usage: { metric: 'api.calls', unitAmount: '0.2', included: 10000 }, currency: 'EUR', interval: 'month' });
    expect(parseUsagePrice('exports 0.0025 EUR')).toEqual({ usage: { metric: 'exports', unitAmount: '0.25' }, currency: 'EUR', interval: undefined });
    expect(parseUsagePrice('seats 5 USD/month').usage.unitAmount).toBe('500');
    expect(() => parseUsagePrice('api.calls 0.002 EUR/month includes 5')).toThrow(/A usage price is/);
  });

  it('puts a usage price on the recurring prices of its currency', () => {
    const prices = [parsePrice('10 EUR/month'), parsePrice('100 EUR/year'), parsePrice('12 USD/month')];
    const out = attachUsage(prices, [parseUsagePrice('api.calls 0.002 EUR')]);
    expect(out.map((p) => p.usage?.length ?? 0)).toEqual([1, 1, 0]);
    expect(() => attachUsage(prices, [parseUsagePrice('api.calls 0.002 SEK/month')])).toThrow(/no recurring SEK\/month price/);
  });
});

describe('plan commands', () => {
  let fake: FakeBridge;
  let cli: ReturnType<typeof createCli>;
  let appId: string;
  const last = (method: string) => fake.requests.filter((r) => r.method === method && r.path.includes('/plans')).pop();

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

  it('create: prices, a trial, a usage price, features and limits in one document', async () => {
    const done = await cli.run([
      'plan', 'create', 'pro', '--name', 'Pro', '--description', 'For teams',
      '--price', '19.99 EUR/month', '--price', '199 EUR/year',
      '--usage-price', 'api.calls 0.002 EUR/month included 10000',
      '--trial-days', '14', '--card-required',
      '--feature', 'analytics=Advanced analytics', '--feature', 'export',
      '--limit', 'api.calls=50000', '--limit', 'seats=unlimited',
    ]);
    expect(done.errors).toEqual([]);
    const request = last('POST');
    expect(request?.path).toBe(`/v2/billing/apps/${appId}/plans`);
    expect(request?.body).toEqual({
      key: 'pro',
      name: 'Pro',
      description: 'For teams',
      prices: [
        { currency: 'EUR', interval: 'month', amount: 1999, usage: [{ metric: 'api.calls', unitAmount: '0.2', included: 10000 }] },
        { currency: 'EUR', interval: 'year', amount: 19900 },
      ],
      features: [{ key: 'analytics', name: 'Advanced analytics' }, { key: 'export' }],
      limits: [{ metric: 'api.calls', limit: 50000 }, { metric: 'seats', limit: null }],
      trial: { days: 14, cardRequired: true },
    });
    expect((await cli.run(['plan', 'list'])).data).toEqual([expect.objectContaining({ key: 'pro' })]);
    expect((await cli.run(['plan', 'get', 'pro'])).data.trial).toEqual({ days: 14, cardRequired: true });
  });

  it('a usage price needs the plan\'s prices', async () => {
    const done = await cli.run(['plan', 'create', 'x', '--name', 'X', '--usage-price', 'api.calls 0.002 EUR/month']);
    expect(done.error).toMatchObject({ code: 'invalid' });
  });

  it('the sub-commands change one entry and write the document back', async () => {
    await cli.run(['plan', 'create', 'pro', '--name', 'Pro', '--price', '10 EUR/month']);
    await cli.run(['plan', 'usage-price', 'set', 'pro', 'api.calls 0.002 EUR/month included 100']);
    await cli.run(['plan', 'price', 'set', 'pro', '12 EUR/month']);
    expect(last('PATCH')?.body).toEqual({ prices: [{ currency: 'EUR', interval: 'month', amount: 1200, usage: [{ metric: 'api.calls', unitAmount: '0.2', included: 100 }] }] });
    await cli.run(['plan', 'price', 'set', 'pro', '120 EUR/year']);
    await cli.run(['plan', 'price', 'remove', 'pro', 'EUR/month']);
    expect(last('PATCH')?.body).toEqual({ prices: [{ currency: 'EUR', interval: 'year', amount: 12000 }] });
    await cli.run(['plan', 'feature', 'add', 'pro', 'analytics']);
    await cli.run(['plan', 'feature', 'add', 'pro', 'export=CSV export']);
    await cli.run(['plan', 'feature', 'remove', 'pro', 'analytics']);
    expect(last('PATCH')?.body).toEqual({ features: [{ key: 'export', name: 'CSV export' }] });
    await cli.run(['plan', 'limit', 'set', 'pro', 'api.calls=1000']);
    await cli.run(['plan', 'limit', 'set', 'pro', 'api.calls=2000']);
    expect(last('PATCH')?.body).toEqual({ limits: [{ metric: 'api.calls', limit: 2000 }] });
    await cli.run(['plan', 'limit', 'remove', 'pro', 'api.calls']);
    expect(last('PATCH')?.body).toEqual({ limits: [] });
    await cli.run(['plan', 'usage-price', 'remove', 'pro', 'api.calls']);
    expect((await cli.run(['plan', 'price', 'remove', 'pro', 'USD/month'])).error).toMatchObject({ code: 'not-found' });
  });

  it('update: names only what changes; --no-trial removes the trial', async () => {
    await cli.run(['plan', 'create', 'pro', '--name', 'Pro', '--trial-days', '7']);
    await cli.run(['plan', 'update', 'pro', '--name', 'Pro+', '--no-trial']);
    expect(last('PATCH')?.body).toEqual({ name: 'Pro+', trial: null });
    expect((await cli.run(['plan', 'update', 'pro'])).error).toMatchObject({ code: 'invalid', message: 'Nothing to change.' });
  });

  it('apply: creates or replaces a plan from a JSON file with PUT', async () => {
    const file = join(cli.dir, 'plan.json');
    writeFileSync(file, JSON.stringify({ key: 'team', name: 'Team', prices: [{ currency: 'EUR', interval: 'month', amount: 4900 }], trial: { days: 30 } }));
    const done = await cli.run(['plan', 'apply', file]);
    expect(done.errors).toEqual([]);
    expect(last('PUT')).toMatchObject({ path: `/v2/billing/apps/${appId}/plans/team`, body: { name: 'Team', prices: [{ currency: 'EUR', interval: 'month', amount: 4900 }], trial: { days: 30 } } });
  });

  it('archive, and delete only when no workspace is on it', async () => {
    await cli.run(['plan', 'create', 'old', '--name', 'Old']);
    expect((await cli.run(['plan', 'archive', 'old'])).data.archived).toBe(true);
    expect(last('POST')?.body).toEqual({ archived: true });
    await cli.run(['plan', 'archive', 'old', '--undo']);
    expect(last('POST')?.body).toEqual({ archived: false });
    fake.holders.set('old', 3);
    expect((await cli.run(['plan', 'delete', 'old', '--dry-run'])).data).toEqual({ key: 'old', holders: 3, deletable: false });
    const refused = await cli.run(['plan', 'delete', 'old']);
    expect(refused.error).toMatchObject({ code: 'conflict' });
    expect(String(refused.error?.['hint'])).toContain('bridge plan archive old');
    fake.holders.set('old', 0);
    expect((await cli.run(['plan', 'delete', 'old'])).data).toEqual({ deleted: 'old' });
  });
});
