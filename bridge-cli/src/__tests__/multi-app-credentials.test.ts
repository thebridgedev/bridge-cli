/**
 * TBP-628 — several apps in one credentials file, switchable without a browser.
 *
 * The bug this replaces was not "switching is inconvenient". It was that a
 * session holding a prod token could run `bridge role list` believing it
 * described the local app, get production's roles, and be one command away from
 * rewriting production — with `BRIDGE_API_KEY` / `BRIDGE_APP_ID` set the whole
 * time and silently doing nothing.
 *
 * So the assertions below are mostly about REFUSALS and about what gets said
 * out loud. Every "silently picks something" path is asserted to throw or to
 * announce, because a convenience feature that guesses would reintroduce the
 * original defect wearing a nicer interface.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ManagementMock = jest.fn();
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: ManagementMock,
  }),
);

const ORIGINAL_ENV = process.env;
let tmpHome: string;
let stderrChunks: string[];
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  jest.resetModules();
  ManagementMock.mockReset();
  process.env = { ...ORIGINAL_ENV };
  for (const key of [
    'BRIDGE_API_KEY',
    'BRIDGE_APP_ID',
    'BRIDGE_BASE_URL',
    'BRIDGE_DEBUG',
    'BRIDGE_PROFILE',
    'BRIDGE_NO_BANNER',
    'XDG_CONFIG_HOME',
  ]) {
    delete process.env[key];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-multiapp-'));
  process.env.HOME = tmpHome;

  stderrChunks = [];
  stderrSpy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const stderr = () => stderrChunks.join('');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

function cred(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'jwt-default',
    expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    issuedAt: new Date().toISOString(),
    app: { id: 'app-prod', name: 'NorthWhistle' },
    user: { id: 'u1', email: 'iman@nebulr.group' },
    baseUrl: 'https://api.thebridge.dev',
    ...overrides,
  };
}

const PROD = cred({
  apiKey: 'jwt-prod',
  app: { id: 'app-prod', name: 'NorthWhistle' },
  label: 'northwhistle-prod-ops',
});

const LOCAL = cred({
  apiKey: 'jwt-local',
  app: { id: 'app-local', name: 'NorthWhistle Local' },
  label: 'northwhistle-local',
  baseUrl: 'http://localhost:3300',
});

function credsDir(): string {
  return path.join(tmpHome, '.config', 'bridge');
}

function credsPath(): string {
  return path.join(credsDir(), 'credentials.json');
}

/** Write the file verbatim — used to plant a v1 file or a hand-made v2 one. */
function planFile(contents: unknown): void {
  fs.mkdirSync(credsDir(), { recursive: true });
  fs.writeFileSync(credsPath(), JSON.stringify(contents, null, 2), { mode: 0o600 });
}

function planV2(entries: Array<Record<string, unknown>>, active: string | null): void {
  planFile({
    version: 2,
    active,
    credentials: Object.fromEntries(
      entries.map((e) => [(e.app as { id: string }).id, e]),
    ),
  });
}

function loadConfig(): typeof import('../config') {
  let mod!: typeof import('../config');
  jest.isolateModules(() => {
    jest.doMock(
      '@nebulr-group/bridge-auth-core',
      () => ({ __esModule: true, BridgeManagement: ManagementMock }),
    );
    mod = require('../config');
  });
  return mod;
}

function loadCredentials(): typeof import('../credentials') {
  let mod!: typeof import('../credentials');
  jest.isolateModules(() => {
    mod = require('../credentials');
  });
  return mod;
}

/** The `{ apiKey, baseUrl }` the client was constructed with. */
function constructedWith(): { apiKey: string; baseUrl: string } {
  expect(ManagementMock).toHaveBeenCalledTimes(1);
  return ManagementMock.mock.calls[0][0];
}

// ---------------------------------------------------------------------------
// 1. Storage: many apps, and the v1 file still works
// ---------------------------------------------------------------------------

describe('credentials store (TBP-628)', () => {
  it('keeps several apps side by side and activates the newest login', () => {
    const c = loadCredentials();
    c.writeCredentials(PROD as never);
    c.writeCredentials(LOCAL as never);

    const file = c.readCredentialsFile()!;
    expect(Object.keys(file.credentials).sort()).toEqual(['app-local', 'app-prod']);
    // Logging in must leave you on the app you just authorised.
    expect(file.active).toBe('app-local');
    // And crucially the FIRST one is still there — the old logout+login dance
    // is what threw valid tokens away.
    expect(file.credentials['app-prod'].apiKey).toBe('jwt-prod');
  });

  it('re-logging into the same app replaces that entry, not the others', () => {
    const c = loadCredentials();
    c.writeCredentials(PROD as never);
    c.writeCredentials(LOCAL as never);
    c.writeCredentials({ ...PROD, apiKey: 'jwt-prod-refreshed' } as never);

    const file = c.readCredentialsFile()!;
    expect(Object.keys(file.credentials)).toHaveLength(2);
    expect(file.credentials['app-prod'].apiKey).toBe('jwt-prod-refreshed');
    expect(file.credentials['app-local'].apiKey).toBe('jwt-local');
  });

  it('reads an existing v1 single-app file with no manual migration', () => {
    // Regression: everybody already on disk has one of these.
    planFile(PROD);
    const c = loadCredentials();

    expect(c.readCredentials()!.apiKey).toBe('jwt-prod');
    const file = c.readCredentialsFile()!;
    expect(file.version).toBe(2);
    expect(file.active).toBe('app-prod');
  });

  it('does NOT rewrite the file just because something read it', () => {
    // A read command must not mutate state another process is reading — and a
    // migration-on-read would do exactly that, concurrently, unprompted.
    planFile(PROD);
    const before = fs.readFileSync(credsPath(), 'utf-8');
    loadCredentials().readCredentials();
    expect(fs.readFileSync(credsPath(), 'utf-8')).toBe(before);
  });

  it('persists the v2 shape the next time something writes', () => {
    planFile(PROD);
    const c = loadCredentials();
    c.writeCredentials(LOCAL as never);

    const raw = JSON.parse(fs.readFileSync(credsPath(), 'utf-8'));
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.credentials).sort()).toEqual(['app-local', 'app-prod']);
  });

  it('writes 0600 with a 0700 parent, same as the single-app file did', () => {
    if (process.platform === 'win32') return;
    const c = loadCredentials();
    c.writeCredentials(PROD as never);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(credsPath()).mode & 0o777).toBe(0o600);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(credsDir()).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// 2. Selecting one: label, id, name — and refusing to guess
// ---------------------------------------------------------------------------

describe('findCredential (TBP-628)', () => {
  beforeEach(() => planV2([PROD, LOCAL], 'app-prod'));

  it('finds by label, which is how people actually name environments', () => {
    expect(loadCredentials().findCredential('northwhistle-local').key).toBe('app-local');
  });

  it('finds by app id', () => {
    expect(loadCredentials().findCredential('app-local').key).toBe('app-local');
  });

  it('finds by app name, case-insensitively', () => {
    expect(loadCredentials().findCredential('northwhistle').key).toBe('app-prod');
  });

  it('prefers a label over an app name that collides with it', () => {
    // Someone labels their local credential with production's app name. The
    // label is the thing they typed on purpose, so it wins.
    planV2(
      [PROD, { ...LOCAL, label: 'NorthWhistle' }],
      'app-prod',
    );
    expect(loadCredentials().findCredential('NorthWhistle').key).toBe('app-local');
  });

  it('throws on an ambiguous selector rather than picking the first match', () => {
    // The whole defect is a wrong app answering silently. Two candidates and a
    // coin flip would be the same defect with extra steps.
    planV2(
      [
        { ...PROD, label: 'shared' },
        { ...LOCAL, label: 'shared' },
      ],
      'app-prod',
    );
    expect(() => loadCredentials().findCredential('shared')).toThrow(/matches 2/);
  });

  it('throws and names what IS stored when nothing matches', () => {
    expect(() => loadCredentials().findCredential('staging')).toThrow(
      /No stored credential matches "staging"/,
    );
    expect(() => loadCredentials().findCredential('staging')).toThrow(
      /northwhistle-prod-ops/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Resolution order in getManagementClient
// ---------------------------------------------------------------------------

describe('getManagementClient resolution (TBP-628)', () => {
  it('uses the active credential when nothing overrides it', () => {
    planV2([PROD, LOCAL], 'app-prod');
    loadConfig().getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-prod');
  });

  it('--profile targets another stored app for this one command', () => {
    planV2([PROD, LOCAL], 'app-prod');
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    cfg.getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-local');
  });

  it('--profile does not change the persisted default', () => {
    // The point of a per-invocation override: a long-running session can target
    // one app for one command without mutating what another process reads.
    planV2([PROD, LOCAL], 'app-prod');
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    cfg.getManagementClient();
    expect(JSON.parse(fs.readFileSync(credsPath(), 'utf-8')).active).toBe('app-prod');
  });

  it('BRIDGE_PROFILE does the same thing as --profile', () => {
    planV2([PROD, LOCAL], 'app-prod');
    process.env.BRIDGE_PROFILE = 'app-local';
    loadConfig().getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-local');
  });

  it('--profile beats BRIDGE_PROFILE', () => {
    planV2([PROD, LOCAL], 'app-prod');
    process.env.BRIDGE_PROFILE = 'northwhistle-prod-ops';
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    cfg.getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-local');
  });

  it('a selected credential keeps its OWN baseUrl', () => {
    // A token issued by a local control plane is worthless against prod's, so
    // the baseUrl has to travel with the credential and not with the default.
    planV2([PROD, LOCAL], 'app-prod');
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    cfg.getManagementClient();
    expect(constructedWith().baseUrl).toBe('http://localhost:3300');
  });

  it('throws when --profile names an app with no stored credential', () => {
    planV2([PROD], 'app-prod');
    const cfg = loadConfig();
    cfg.setProfileOverride('app-staging');
    expect(() => cfg.getManagementClient()).toThrow(/No stored credential matches/);
    expect(ManagementMock).not.toHaveBeenCalled();
  });

  it('an expired --profile is an error, NOT a fallback to a valid other app', () => {
    // The single most dangerous silent behaviour available: you ask for local,
    // local has expired, and prod answers.
    planV2(
      [PROD, { ...LOCAL, expiresAt: new Date(Date.now() - HOUR).toISOString() }],
      'app-prod',
    );
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    expect(() => cfg.getManagementClient()).toThrow(/expired/);
    expect(() => cfg.getManagementClient()).toThrow(/Refusing to fall back/);
    expect(ManagementMock).not.toHaveBeenCalled();
  });

  it('an expired --profile does not fall back to BRIDGE_API_KEY either', () => {
    planV2([{ ...LOCAL, expiresAt: new Date(Date.now() - HOUR).toISOString() }], 'app-local');
    process.env.BRIDGE_API_KEY = 'ci-key';
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    expect(() => cfg.getManagementClient()).toThrow(/expired/);
    expect(ManagementMock).not.toHaveBeenCalled();
  });

  it('refuses to guess when the active pointer is dangling and several remain', () => {
    planV2([PROD, LOCAL], 'app-deleted');
    const cfg = loadConfig();
    expect(() => cfg.getManagementClient()).toThrow(/Not logged in/);
  });

  it('falls back to the only entry when the pointer dangles and there is one', () => {
    // One candidate is not a guess.
    planV2([PROD], 'app-deleted');
    loadConfig().getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-prod');
  });

  it('REGRESSION: CI shape — no file, BRIDGE_API_KEY only — is unchanged', () => {
    process.env.BRIDGE_API_KEY = 'ci-key';
    loadConfig().getManagementClient();
    expect(constructedWith()).toMatchObject({
      apiKey: 'ci-key',
      baseUrl: 'https://api.thebridge.dev',
    });
  });

  it('REGRESSION: the credentials file still beats BRIDGE_API_KEY', () => {
    // Deliberately unchanged: `bridge auth login` must take effect immediately.
    // What changed is that the CLI now says the env var is being ignored.
    planV2([PROD], 'app-prod');
    process.env.BRIDGE_API_KEY = 'ci-key';
    loadConfig().getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-prod');
  });
});

// ---------------------------------------------------------------------------
// 4. The banner — the half that would actually have caught the incident
// ---------------------------------------------------------------------------

describe('context banner (TBP-628)', () => {
  it('names the app on a plain read, not only on writes', () => {
    // The reported near-miss began with `bridge role list`. The wrong belief
    // was formed by the read; a write-only banner would have been too late.
    planV2([PROD], 'app-prod');
    loadConfig().getManagementClient();
    expect(stderr()).toContain('northwhistle-prod-ops');
    expect(stderr()).toContain('app-prod');
    expect(stderr()).toContain('https://api.thebridge.dev');
  });

  it('says which mechanism chose the app', () => {
    planV2([PROD, LOCAL], 'app-prod');
    const cfg = loadConfig();
    cfg.setProfileOverride('northwhistle-local');
    cfg.getManagementClient();
    expect(stderr()).toContain('via --profile northwhistle-local');
  });

  it('says "saved default" when nothing was named', () => {
    planV2([PROD], 'app-prod');
    loadConfig().getManagementClient();
    expect(stderr()).toContain('via saved default');
  });

  it('goes to stderr, so stdout stays parseable', () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      planV2([PROD], 'app-prod');
      loadConfig().getManagementClient();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('says out loud that BRIDGE_API_KEY is being ignored', () => {
    // Observed on 0.4.4: the env vars were accepted without complaint and had
    // no effect, and the session believed them.
    planV2([PROD], 'app-prod');
    process.env.BRIDGE_API_KEY = 'local-app-key';
    loadConfig().getManagementClient();
    expect(stderr()).toMatch(/BRIDGE_API_KEY is set but IGNORED/);
    expect(stderr()).toContain('--profile');
  });

  it('says out loud that BRIDGE_APP_ID has no effect', () => {
    planV2([PROD], 'app-prod');
    process.env.BRIDGE_APP_ID = 'app-local';
    loadConfig().getManagementClient();
    expect(stderr()).toMatch(/BRIDGE_APP_ID has no effect/);
  });

  it('does not cry wolf: no ignored-env note when the env var IS in use', () => {
    process.env.BRIDGE_API_KEY = 'ci-key';
    loadConfig().getManagementClient();
    expect(stderr()).not.toMatch(/IGNORED/);
    expect(stderr()).toContain('via BRIDGE_API_KEY');
  });

  it('BRIDGE_NO_BANNER=true silences it', () => {
    planV2([PROD], 'app-prod');
    process.env.BRIDGE_NO_BANNER = 'true';
    loadConfig().getManagementClient();
    expect(stderr()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. Switching and removing
// ---------------------------------------------------------------------------

describe('setActiveCredential / removeCredential (TBP-628)', () => {
  it('switches the default offline — no token is reissued', () => {
    planV2([PROD, LOCAL], 'app-prod');
    const c = loadCredentials();
    c.setActiveCredential('app-local');

    const file = c.readCredentialsFile()!;
    expect(file.active).toBe('app-local');
    // Both tokens survive untouched: switching is a pointer move, which is the
    // entire reason it does not need a browser.
    expect(file.credentials['app-prod'].apiKey).toBe('jwt-prod');
    expect(file.credentials['app-local'].apiKey).toBe('jwt-local');
  });

  it('removing the active credential re-points active at a survivor', () => {
    // A dangling pointer with credentials still stored would report "no active
    // credential" to somebody who is very much still logged in.
    planV2([PROD, LOCAL], 'app-prod');
    const c = loadCredentials();
    expect(c.removeCredential('app-prod')).toBe(1);

    const file = c.readCredentialsFile()!;
    expect(file.active).toBe('app-local');
    expect(file.credentials['app-prod']).toBeUndefined();
  });

  it('removing the last credential deletes the file', () => {
    planV2([PROD], 'app-prod');
    const c = loadCredentials();
    expect(c.removeCredential('app-prod')).toBe(0);
    expect(fs.existsSync(credsPath())).toBe(false);
  });

  it('removing one app leaves the other usable immediately', () => {
    planV2([PROD, LOCAL], 'app-prod');
    loadCredentials().removeCredential('app-prod');
    loadConfig().getManagementClient();
    expect(constructedWith().apiKey).toBe('jwt-local');
  });
});
