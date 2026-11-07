/**
 * The contract: every endpoint the CLI calls is one Bridge's API promises at
 * version 2, in the pinned copy of its contract (`contract/public-api.v2.json`,
 * with the commit it was copied at). The command tests go further: the fake
 * Bridge refuses any request, or any body field, the contract does not list.
 */
import { readMetadata } from '../core/discovery';
import { ROUTES, contractPath } from '../core/routes';
import { BASE, BRIDGE_APP, CONTRACT, DISCOVERY, ISSUER, contractEntry } from './helpers/fake-bridge';

describe('the pinned contract', () => {
  it('records where it was copied from', () => {
    expect(CONTRACT.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(DISCOVERY.source.commit).toBe(CONTRACT.source.commit);
  });

  it.each(Object.entries(ROUTES))('%s is promised at version 2', (_name, route) => {
    const path = contractPath(route);
    expect(path.startsWith('/v2/')).toBe(true);
    const entry = contractEntry(route.method, path.replace(/\{[A-Za-z]+\}/g, 'x'));
    expect(entry).toBeDefined();
    expect(entry?.path).toBe(path);
    // The credential the CLI sends is one the endpoint takes.
    if (route.auth === 'person') expect(entry?.callers).toContain('person');
    if (route.auth === 'app-key') expect(entry?.callers).toContain('app_key');
    if (route.auth === 'none') expect(entry?.public).toBe(true);
    // App-key routes that act in a workspace are the ones the CLI sends Bridge-Workspace on.
    if (route.auth === 'app-key') expect(entry?.requires.includes('workspace')).toBe('workspace' in route);
  });

  it('every operator route is for a person in their workspace, as the developer is', () => {
    for (const route of Object.values(ROUTES).filter((r) => r.auth === 'person' && r.path.includes('{appId}'))) {
      expect(contractEntry(route.method, contractPath(route).replace(/\{[A-Za-z]+\}/g, 'x'))?.requires).toContain('workspace');
    }
  });
});

describe('discovery against the pinned metadata document', () => {
  const document = () => JSON.parse(JSON.stringify(DISCOVERY.document).replaceAll('{base}', BASE).replaceAll('{app}', BRIDGE_APP)) as Record<string, any>;

  it('reads every endpoint the CLI needs from bridge_endpoints["2"]', () => {
    const d = readMetadata(ISSUER, document());
    expect(d).toEqual({
      issuer: ISSUER,
      appId: BRIDGE_APP,
      signIn: `${BASE}/v2/identity-access/apps/${BRIDGE_APP}/sign-in`,
      token: `${BASE}/v2/identity-access/apps/${BRIDGE_APP}/token`,
      revoke: `${BASE}/v2/identity-access/apps/${BRIDGE_APP}/revoke`,
      signOut: `${BASE}/v2/identity-access/sign-out`,
      signInPage: null,
      bases: {
        'app-registry': `${BASE}/v2/app-registry`,
        'identity-access': `${BASE}/v2/identity-access`,
        billing: `${BASE}/v2/billing`,
        flags: `${BASE}/v2/flags`,
        accounts: `${BASE}/v2/accounts`,
      },
    });
  });

  it('prefers version 2\'s own list over standard fields that point elsewhere', () => {
    const doc = document();
    doc['token_endpoint'] = `${BASE}/v3/identity-access/apps/${BRIDGE_APP}/token`;
    expect(readMetadata(ISSUER, doc).token).toBe(`${BASE}/v2/identity-access/apps/${BRIDGE_APP}/token`);
  });

  it('falls back to the standard fields only for an issuer at version 2', () => {
    const doc = document();
    delete doc['bridge_endpoints']['2']['token'];
    expect(readMetadata(ISSUER, doc).token).toBe(`${BASE}/v2/identity-access/apps/${BRIDGE_APP}/token`);
    doc['bridge_api_version'] = 3;
    expect(() => readMetadata(ISSUER, doc)).toThrow(/no "token" endpoint/);
  });

  it('reads the sign-in page when the issuer lists one', () => {
    const doc = document();
    doc['bridge_endpoints']['2']['sign_in_page'] = 'https://signin.bridge.test/cli';
    expect(readMetadata(ISSUER, doc).signInPage).toBe('https://signin.bridge.test/cli');
  });

  it('refuses an issuer that is not at version 2, another issuer, or an address that is not https', () => {
    const noV2 = document();
    delete noV2['bridge_endpoints'];
    noV2['bridge_api_version'] = 3;
    expect(() => readMetadata(ISSUER, noV2)).toThrow(/does not offer version 2/);
    expect(() => readMetadata(`${ISSUER}-other`, document())).toThrow(/another issuer/);
    const plain = document();
    plain['bridge_endpoints']['2']['billing'] = 'http://bridge.test/v2/billing';
    expect(() => readMetadata(ISSUER, plain)).toThrow(/not https/);
  });

  it('allows http on this machine, for local development', () => {
    const local = 'http://localhost:3100';
    const doc = JSON.parse(JSON.stringify(DISCOVERY.document).replaceAll('{base}', local).replaceAll('{app}', BRIDGE_APP));
    expect(readMetadata(`${local}/identity-access/apps/${BRIDGE_APP}`, doc).bases.billing).toBe(`${local}/v2/billing`);
  });
});
