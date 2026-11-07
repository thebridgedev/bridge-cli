/**
 * The temporary app key is revoked on every path: when the command is done,
 * when it fails, and when it is stopped (SIGINT, SIGTERM). When it cannot
 * be revoked, the CLI names the key to revoke, by id, never by secret.
 */
import { EventEmitter } from 'node:events';
import { withAppKey } from '../api/keys';
import { Sessions } from '../auth/session';
import { FileStore } from '../auth/store';
import { BridgeClient } from '../client';
import { discover } from '../core/discovery';
import type { Fetch } from '../core/http';
import { createFakeBridge, ISSUER, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

let fake: FakeBridge;
let cli: ReturnType<typeof createCli>;
let appId: string;

beforeEach(async () => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: 'correct horse' });
  cli = createCli(fake);
  await cli.signIn();
  appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
});
afterEach(() => cli.cleanup());

async function client(fetchFn: Fetch = fake.fetch): Promise<BridgeClient> {
  return new BridgeClient(await discover(fetchFn, ISSUER), fetchFn, new Sessions({ fetch: fetchFn, store: new FileStore(cli.dir), lockDir: cli.dir, now: fake.now }));
}

/** A fetch that cannot revoke keys. */
const noRevoke: Fetch = async (input, init) => {
  if (init?.method === 'DELETE' && input.includes('/keys/')) throw new TypeError('fetch failed');
  return fake.fetch(input, init);
};

const temporary = () => [...fake.keys.values()].filter((k) => k.name === 'bridge-cli (temporary)');

it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('%s while the command runs revokes the key, then exits %i', async (signal, code) => {
  const signals = new EventEmitter();
  const exited: number[] = [];
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  void withAppKey(await client(), appId, ['USER_READ'], {}, () => {
    started();
    return new Promise(() => undefined); // a command that hangs
  }, { signals, exit: (n) => exited.push(n), warn: () => undefined });
  await running;
  expect(temporary().map((k) => k.revoked)).toEqual([false]);
  expect(signals.listenerCount(signal)).toBe(1);
  signals.emit(signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(temporary().map((k) => k.revoked)).toEqual([true]);
  expect(exited).toEqual([code]);
});

it('a stopped command whose key cannot be revoked names the key, never its secret', async () => {
  const signals = new EventEmitter();
  const warnings: string[] = [];
  const exited: number[] = [];
  let seen = '';
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  void withAppKey(await client(noRevoke), appId, [], {}, (key) => {
    seen = key;
    started();
    return new Promise(() => undefined);
  }, { signals, exit: (n) => exited.push(n), warn: (m) => warnings.push(m), revokeTimeoutMs: 1000 });
  await running;
  signals.emit('SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const id = temporary()[0]?.id as string;
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`bridge key revoke ${id}`);
  expect(warnings[0]).not.toContain(seen);
  expect(warnings[0]).not.toContain(seen.split('.')[3]);
  expect(exited).toEqual([130]);
});

it('a revoke that hangs is given up after the limit, and the command still exits', async () => {
  const signals = new EventEmitter();
  const warnings: string[] = [];
  const exited: number[] = [];
  const hangs: Fetch = async (input, init) => (init?.method === 'DELETE' ? new Promise<Response>(() => undefined) : fake.fetch(input, init));
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  void withAppKey(await client(hangs), appId, [], {}, () => (started(), new Promise(() => undefined)), { signals, exit: (n) => exited.push(n), warn: (m) => warnings.push(m), revokeTimeoutMs: 100 });
  await running;
  signals.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(warnings[0]).toContain('no answer within 0.1 s');
  expect(exited).toEqual([143]);
});

it('a command that fails revokes the key; a failed revoke prints the warning; the signal handlers are removed', async () => {
  const signals = new EventEmitter();
  await expect(withAppKey(await client(), appId, [], {}, async () => {
    throw new Error('the command failed');
  }, { signals, warn: () => undefined })).rejects.toThrow('the command failed');
  expect(temporary().every((k) => k.revoked)).toBe(true);
  expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);

  const warnings: string[] = [];
  await expect(withAppKey(await client(noRevoke), appId, [], {}, async () => {
    throw new Error('failed again');
  }, { signals, warn: (m) => warnings.push(m) })).rejects.toThrow('failed again');
  expect(warnings[0]).toMatch(/^The temporary key key-\d+ could not be revoked/);
});
