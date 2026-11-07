/** Metrics, taxes, billing settings, products, and Stripe in test mode by a pasted key. */
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
});
afterEach(() => {
  expect(fake.violations).toEqual([]);
  cli.cleanup();
});

describe('metric, tax, billing settings, product', () => {
  it('metric set / list / remove', async () => {
    expect((await cli.run(['metric', 'set', 'exports', '--kind', 'counter', '--name', 'Exports'])).data).toEqual({ key: 'exports', name: 'Exports', kind: 'counter' });
    expect(last('PUT', '/metrics/exports')?.body).toEqual({ kind: 'counter', name: 'Exports' });
    expect((await cli.run(['metric', 'list'])).data.map((m: { key: string }) => m.key)).toEqual(['api.calls', 'exports']);
    expect((await cli.run(['metric', 'set', 'x', '--kind', 'sum'])).error).toMatchObject({ code: 'invalid' });
    await cli.run(['metric', 'remove', 'exports']);
    expect(last('DELETE', '/metrics/exports')).toBeDefined();
  });

  it('tax set takes a percent and sends basis points for the upper-case country', async () => {
    const done = await cli.run(['tax', 'set', 'se', '--name', 'VAT', '--rate', '25']);
    expect(done.data).toEqual({ country: 'SE', name: 'VAT', basisPoints: 2500 });
    expect(last('PUT', '/taxes/SE')?.body).toEqual({ name: 'VAT', basisPoints: 2500 });
    expect((await cli.run(['tax', 'set', 'DE', '--name', 'MwSt', '--rate', '7.5'])).data.basisPoints).toBe(750);
    expect((await cli.run(['tax', 'set', 'DE', '--name', 'MwSt', '--rate', '7.555'])).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['tax', 'list'])).data).toHaveLength(2);
    await cli.run(['tax', 'remove', 'de']);
    expect(last('DELETE', '/taxes/DE')).toBeDefined();
  });

  it('billing settings shows them, or changes the ones given', async () => {
    expect((await cli.run(['billing', 'settings'])).data).toEqual({ currency: null, paymentsAutoRedirect: false, returnUrl: null });
    await cli.run(['billing', 'settings', '--currency', 'eur', '--return-url', 'https://demo.example.com/billing', '--auto-redirect']);
    expect(last('PATCH', '/settings')?.body).toEqual({ currency: 'EUR', returnUrl: 'https://demo.example.com/billing', paymentsAutoRedirect: true });
  });

  it('product create / archive / delete', async () => {
    const done = await cli.run(['product', 'create', 'extra-seats', '--name', 'Extra seats', '--kind', 'addon', '--price', '5 EUR/month', '--adds', 'seats=1']);
    expect(done.errors).toEqual([]);
    expect(last('POST', '/products')?.body).toEqual({ key: 'extra-seats', name: 'Extra seats', kind: 'addon', prices: [{ currency: 'EUR', interval: 'month', amount: 500 }], limits: [{ metric: 'seats', add: 1 }] });
    await cli.run(['product', 'archive', 'extra-seats']);
    expect(last('POST', '/archive')?.body).toEqual({ archived: true });
    expect((await cli.run(['product', 'create', 'x', '--name', 'X', '--kind', 'bundle'])).error).toMatchObject({ code: 'invalid' });
    await cli.run(['product', 'delete', 'extra-seats']);
    expect(last('DELETE', '/products/extra-seats')).toBeDefined();
  });
});

describe('stripe', () => {
  it('connect: the pasted test key goes through the app-key route with a temporary key, which is revoked after', async () => {
    const done = await cli.run(['stripe', 'connect', '--secret-key-stdin', '--publishable-key', 'pk_test_abc123'], { stdin: 'sk_test_abc123\n' });
    expect(done.errors).toEqual([]);
    expect(done.data).toMatchObject({ connector: 'stripe', status: 'active' });

    const made = last('POST', `/v2/identity-access/apps/${appId}/keys`);
    expect(made?.body).toEqual({ name: 'bridge-cli (temporary)', privileges: [], expiresInDays: 1 });
    const connect = last('POST', '/v2/billing/connection');
    expect(connect?.headers['x-api-key']).toMatch(new RegExp(`^bk\\.${appId}\\.`));
    expect(connect?.headers['authorization']).toBeUndefined();
    expect(connect?.body).toEqual({ connector: 'stripe', secretKey: 'sk_test_abc123', publishableKey: 'pk_test_abc123' });
    expect(fake.pastedKeys).toEqual(['sk_test_abc123']);
    // The temporary key is gone, and the secret key is in no output.
    expect([...fake.keys.values()].every((k) => k.revoked)).toBe(true);
    expect(JSON.stringify([done.results, done.infos])).not.toContain('sk_test_abc123');

    expect((await cli.run(['stripe', 'status'])).data).toMatchObject({ connector: 'stripe', status: 'active' });
  });

  it('connect uses BRIDGE_APP_KEY when it is set, and makes no key', async () => {
    const made = await cli.run(['key', 'create', '--name', 'server']);
    const before = fake.keys.size;
    const done = await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'sk_test_xyz', env: { BRIDGE_APP_KEY: made.data.key } });
    expect(done.errors).toEqual([]);
    expect(fake.keys.size).toBe(before);
    expect(last('POST', '/v2/billing/connection')?.headers['x-api-key']).toBe(made.data.key);
  });

  it('connect refuses a key of another app in BRIDGE_APP_KEY', async () => {
    const done = await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'sk_test_xyz', env: { BRIDGE_APP_KEY: 'bk.other-app.k1.s3cret' } });
    expect(done.error).toMatchObject({ code: 'misconfigured' });
  });

  it('connect asks for the key without echo in a terminal, and refuses a live key unless --live', async () => {
    expect((await cli.run(['stripe', 'connect'], { interactive: true, answers: ['sk_test_typed'] })).errors).toEqual([]);
    const live = await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'sk_live_real' });
    expect(live.error).toMatchObject({ code: 'invalid' });
    expect(String(live.error?.['message'])).toContain('live key');
    expect((await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'not-a-key' })).error).toMatchObject({ code: 'invalid' });
    expect((await cli.run(['stripe', 'connect'])).error).toMatchObject({ code: 'invalid', message: 'No terminal to ask for the key in.' });
  });

  it('connect long after sign-in: the temporary key needs a recent sign-in, and says so', async () => {
    fake.advance(10 * 60_000);
    const done = await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'sk_test_abc' });
    expect(done.error).toMatchObject({ code: 'reauthenticate' });
    expect(String(done.error?.['hint'])).toContain('BRIDGE_APP_KEY');
  });

  it('disconnect', async () => {
    await cli.run(['stripe', 'connect', '--secret-key-stdin'], { stdin: 'sk_test_abc' });
    expect((await cli.run(['stripe', 'disconnect', '--yes'])).data).toMatchObject({ status: 'disconnected' });
  });
});
