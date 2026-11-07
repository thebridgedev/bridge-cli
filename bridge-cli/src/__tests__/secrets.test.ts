/**
 * No secret leaks: the password, the tokens, the temporary key's secret and
 * a pasted Stripe key appear in no output (stdout or stderr) and in no
 * argument of the keychain tool, on the error paths too.
 */
import { MacKeychainStore, type Runner } from '../auth/store';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { createCli } from './helpers/run';

const PASSWORD = 'correct horse battery';

/** The macOS keychain tool, played in memory, recording every argument it is given. */
function recordingKeychain() {
  const entries = new Map<string, string>();
  const argv: string[] = [];
  const run: Runner = async (command, args, input) => {
    argv.push([command, ...args].join(' '));
    if (args[0] === '-i') {
      entries.set(/-a "([^"]+)"/.exec(input ?? '')?.[1] as string, /-w "([^"]+)"/.exec(input ?? '')?.[1] as string);
      return { code: 0, stdout: '', stderr: '' };
    }
    const account = args[args.indexOf('-a') + 1] as string;
    if (args[0] === 'find-generic-password') {
      const value = entries.get(account);
      return value === undefined ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: value, stderr: '' };
    }
    entries.delete(account);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, argv };
}

let fake: FakeBridge;
let keychain: ReturnType<typeof recordingKeychain>;
let cli: ReturnType<typeof createCli>;

beforeEach(() => {
  fake = createFakeBridge();
  fake.addPerson({ email: 'dev@example.com', password: PASSWORD });
  keychain = recordingKeychain();
  cli = createCli(fake, { store: () => new MacKeychainStore(keychain.run) });
});
afterEach(() => cli.cleanup());

function expectNoneOf(secrets: string[], ...places: string[]) {
  for (const secret of secrets.filter((each) => each.length > 0)) {
    for (const place of places) expect(place.includes(secret) ? `leaked ${secret.slice(0, 6)}…` : null).toBeNull();
  }
}

it('a wrong password is in no output', async () => {
  const done = await cli.run(['auth', 'login', '--password', '--email', 'dev@example.com', '--password-stdin'], { stdin: 'wrong horse battery' });
  expect(done.error).toMatchObject({ code: 'wrong-credentials' });
  expectNoneOf(['wrong horse battery'], done.output, keychain.argv.join('\n'));
});

it('signing in, renewing and signing out: the password and the tokens are in no output and no keychain argument', async () => {
  const runs = [await cli.signIn('dev@example.com', PASSWORD)];
  fake.advance(290_000);
  runs.push(await cli.run(['auth', 'whoami']));
  runs.push(await cli.run(['auth', 'logout']));
  expect(runs.map((r) => r.exitCode)).toEqual([0, 0, 0]);
  expect(fake.tokens().length).toBeGreaterThanOrEqual(4);
  expectNoneOf([PASSWORD, ...fake.tokens()], ...runs.map((r) => r.output), keychain.argv.join('\n'));
});

it('Stripe refusing the key: the pasted key and the temporary key\'s secret are in no output', async () => {
  await cli.signIn('dev@example.com', PASSWORD);
  const appId = fake.addApp({ name: 'Demo', owner: 'ws-1' });
  const done = await cli.run(['stripe', 'connect', '--secret-key-stdin', '--app', appId], { stdin: 'sk_test_refused' });
  expect(done.error).toMatchObject({ code: 'invalid', status: 400 });
  const temporary = [...fake.keys.values()];
  expect(temporary).toHaveLength(1);
  expect(temporary[0]?.revoked).toBe(true);
  expectNoneOf(['sk_test_refused', temporary[0]?.secret as string, ...fake.tokens()], done.output, keychain.argv.join('\n'));
});
