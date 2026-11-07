/**
 * A fake Bridge for the CLI's tests, served through `fetch`.
 *
 * It answers like Bridge's version 2 API for what the CLI calls, and it is
 * strict about the contract: every request must match an endpoint of the
 * pinned contract (`contract/public-api.v2.json`) and send only the body
 * fields that endpoint lists, else it answers 500 and records a violation.
 * Its metadata document is the pinned one (`contract/discovery.v2.json`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ContractEntry {
  method: string;
  path: string;
  public: boolean;
  callers: string[];
  privilege: string | null;
  fields: string[];
  requires: string[];
}

const ROOT = join(__dirname, '..', '..', '..');
export const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'contract', 'public-api.v2.json'), 'utf8')) as { source: { commit: string }; endpoints: ContractEntry[] };
export const DISCOVERY = JSON.parse(readFileSync(join(ROOT, 'contract', 'discovery.v2.json'), 'utf8')) as { source: { commit: string }; document: Record<string, unknown> };

export const BASE = 'https://bridge.test';
export const BRIDGE_APP = 'bridge-app';
export const ISSUER = `${BASE}/identity-access/apps/${BRIDGE_APP}`;
const V2 = `${BASE}/v2`;

const patterns = CONTRACT.endpoints.map((entry) => ({
  entry,
  regex: new RegExp(`^${entry.path.replace(/[.]/g, '\\.').replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

export function contractEntry(method: string, path: string): ContractEntry | undefined {
  return patterns.find((each) => each.entry.method === method && each.regex.test(path))?.entry;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const secret = () => b64url(randomBytes(16));
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

interface Person {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  workspaces: { id: string; name: string }[];
}

interface Session {
  person: Person;
  workspace: string | null;
  authTime: number;
  ended: boolean;
}

type Json = Record<string, unknown>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function problem(status: number, kind: string, detail: string, extra: Json = {}, headers: Record<string, string> = {}): Response {
  return json(status, { type: `urn:bridge:problem:${kind}`, title: String(status), status, detail, ...extra }, { 'content-type': 'application/problem+json', ...headers });
}

const notFound = () => json(404, { type: 'about:blank', title: 'Not Found', status: 404 });

export function createFakeBridge() {
  let clock = 1_800_000_000_000;
  const requests: Recorded[] = [];
  const violations: string[] = [];
  const people = new Map<string, Person>();
  const codes = new Map<string, { session: Omit<Session, 'ended'>; challenge: string }>();
  const flows = new Map<string, { person: Person; challenge: string }>();
  const sessions = new Map<string, Session>();
  const accessTokens = new Map<string, { session: string; exp: number }>();
  const refreshTokens = new Map<string, { session: string; used: boolean }>();
  const revoked: string[] = [];

  const apps = new Map<string, Json>();
  const keys = new Map<string, { id: string; app: string; name: string; privileges: string[]; secret: string; revoked: boolean; expiresInDays?: number }>();
  const plans = new Map<string, Map<string, Json>>();
  const products = new Map<string, Map<string, Json>>();
  const metrics = new Map<string, Map<string, Json>>();
  const taxes = new Map<string, Map<string, Json>>();
  const settings = new Map<string, Json>();
  const connections = new Map<string, Json>();
  const pastedKeys: string[] = [];
  const flags = new Map<string, Map<string, Json>>();
  const roles = new Map<string, Json[]>();
  const privileges = new Map<string, Json[]>();
  const workspaces = new Map<string, Json[]>();
  const members = new Map<string, Json[]>();
  const holders = new Map<string, number>();
  let ids = 0;
  const id = (prefix: string) => `${prefix}-${String(++ids)}`;

  const perApp = <T>(map: Map<string, T>, app: string, make: () => T): T => {
    if (!map.has(app)) map.set(app, make());
    return map.get(app) as T;
  };

  function metadata(): Json {
    const text = JSON.stringify(DISCOVERY.document).replaceAll('{base}', BASE).replaceAll('{app}', BRIDGE_APP);
    return JSON.parse(text) as Json;
  }

  function issue(sessionId: string): Json {
    const session = sessions.get(sessionId) as Session;
    const access = `at-${secret()}`;
    const refresh = `rt-${secret()}`;
    accessTokens.set(access, { session: sessionId, exp: clock + 300_000 });
    refreshTokens.set(refresh, { session: sessionId, used: false });
    return { access_token: access, token_type: 'Bearer', expires_in: 300, refresh_token: refresh, id_token: 'unused', ...(session.workspace === null ? {} : { workspace: session.workspace }) };
  }

  function codeFor(person: Person, workspace: string | null, challenge: string): Response {
    const code = `code-${secret()}`;
    codes.set(code, { session: { person, workspace, authTime: clock }, challenge });
    return json(200, { code });
  }

  /** The challenge endpoint: what the CLI's password sign-in and Bridge's sign-in page (hand-off mode) both call. */
  function signIn(body: Json): Response {
    if (typeof body['flow'] === 'string') {
      const flow = flows.get(body['flow']);
      if (!flow) return json(400, { error: 'flow_expired' });
      flows.delete(body['flow']);
      const workspace = String(body['workspace']);
      if (!flow.person.workspaces.some((each) => each.id === workspace)) return json(403, { error: 'access_denied', reason: 'not_a_member' });
      return codeFor(flow.person, workspace, flow.challenge);
    }
    if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string') return json(400, { error: 'invalid_request' });
    const person = people.get(String(body['email']));
    if (!person || person.password !== body['password']) return json(400, { error: 'wrong_credentials' });
    const requested = typeof body['workspace'] === 'string' ? body['workspace'] : null;
    if (requested === null && person.workspaces.length > 1) {
      const handle = `flow-${secret()}`;
      flows.set(handle, { person, challenge: body['code_challenge'] });
      return json(200, { next: 'workspace', flow: handle, workspaces: person.workspaces.map((each) => ({ ...each, logo: null })) });
    }
    const workspace = requested ?? person.workspaces[0]?.id ?? null;
    if (workspace !== null && !person.workspaces.some((each) => each.id === workspace)) return json(403, { error: 'access_denied', reason: 'not_a_member' });
    return codeFor(person, workspace, body['code_challenge']);
  }

  function token(body: Json): Response {
    if (body['client_id'] !== undefined && body['client_id'] !== BRIDGE_APP) return json(400, { error: 'invalid_client' });
    if (body['grant_type'] === 'authorization_code') {
      const found = codes.get(String(body['code']));
      codes.delete(String(body['code']));
      if (!found || s256(String(body['code_verifier'])) !== found.challenge) return json(400, { error: 'invalid_grant', error_description: 'The code is not valid.' });
      const sessionId = id('session');
      sessions.set(sessionId, { ...found.session, ended: false });
      return json(200, issue(sessionId), { 'cache-control': 'no-store' });
    }
    if (body['grant_type'] === 'refresh_token') {
      const found = refreshTokens.get(String(body['refresh_token']));
      if (!found) return json(400, { error: 'invalid_grant', error_description: 'The refresh token is not valid.' });
      const session = sessions.get(found.session) as Session;
      if (found.used) {
        // Reuse: the session ends.
        session.ended = true;
        return json(400, { error: 'invalid_grant', error_description: 'The refresh token was used before.' });
      }
      if (session.ended) return json(400, { error: 'invalid_grant', error_description: 'The session ended.' });
      if (body['workspace'] !== undefined) {
        if (!session.person.workspaces.some((each) => each.id === body['workspace'])) return json(403, { error: 'access_denied', reason: 'not_a_member' });
        session.workspace = String(body['workspace']);
      }
      found.used = true;
      return json(200, issue(found.session));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  /** Who the request is from: a person's token, or an app key. */
  function caller(headers: Record<string, string>): { kind: 'person'; session: Session } | { kind: 'key'; key: NonNullable<ReturnType<typeof keys.get>> } | Response | null {
    const apiKey = headers['x-api-key'];
    if (apiKey !== undefined) {
      const parts = apiKey.split('.');
      const key = keys.get(parts[2] ?? '');
      if (!key || key.revoked || key.secret !== parts[3] || key.app !== parts[1]) return problem(401, 'credential-refused', 'The key is not active.');
      return { kind: 'key', key };
    }
    const bearer = /^Bearer (.+)$/.exec(headers['authorization'] ?? '')?.[1];
    if (bearer === undefined) return null;
    const access = accessTokens.get(bearer);
    if (!access || access.exp <= clock || (sessions.get(access.session) as Session).ended) {
      return problem(401, 'credential-refused', 'The token is not valid.', {}, { 'www-authenticate': 'Bearer realm="bridge", error="invalid_token"' });
    }
    return { kind: 'person', session: sessions.get(access.session) as Session };
  }

  async function handle(method: string, url: URL, headers: Record<string, string>, body: Json | undefined): Promise<Response> {
    const path = url.pathname;
    if (method === 'GET' && path === `/identity-access/apps/${BRIDGE_APP}/.well-known/openid-configuration`) return json(200, metadata());

    const entry = contractEntry(method, path);
    if (!entry) {
      violations.push(`${method} ${path} is not in the contract`);
      return json(500, { error: 'not_in_contract' });
    }
    const extra = body === undefined ? [] : Object.keys(body).filter((field) => !entry.fields.includes(field));
    if (extra.length > 0) {
      violations.push(`${method} ${path} sends ${extra.join(', ')}, which the contract does not list`);
      return json(500, { error: 'field_not_in_contract' });
    }
    const input = body ?? {};
    const ia = `/v2/identity-access/apps/${BRIDGE_APP}`;
    if (method === 'POST' && path === `${ia}/sign-in`) return signIn(input);
    if (method === 'POST' && path === `${ia}/token`) return token(input);
    if (method === 'POST' && path === `${ia}/revoke`) {
      const found = refreshTokens.get(String(input['token']));
      if (found) {
        (sessions.get(found.session) as Session).ended = true;
        revoked.push(String(input['token']));
      }
      return json(200, {});
    }

    const who = caller(headers);
    if (who instanceof Response) return who;
    if (who === null) return problem(401, 'credential-missing', 'This route needs a token or a key.');
    if (who.kind === 'person' && !entry.callers.includes('person')) return problem(401, 'credential-refused', 'Not for a person.');
    if (who.kind === 'key' && !entry.callers.includes('app_key')) return problem(401, 'credential-refused', 'Not for a key.');

    if (who.kind === 'person') {
      if (entry.requires.includes('workspace') && who.session.workspace === null) return problem(403, 'workspace-missing', 'Sign in to a workspace.');
      if (entry.requires.includes('recent-sign-in') && clock - who.session.authTime > 300_000) {
        return problem(401, 'identity-recheck', 'Sign in again to confirm it is you.', { maxAge: 300 });
      }
      if (method === 'POST' && path === '/v2/identity-access/sign-out') {
        who.session.ended = true;
        return json(200, {});
      }
      if (method === 'GET' && path === '/v2/accounts/me') {
        const p = who.session.person;
        return json(200, { id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName, workspaces: p.workspaces.map((each) => ({ ...each, role: 'OWNER' })) });
      }
      return operator(method, path, url, headers, input, who.session);
    }
    if (entry.requires.includes('workspace') && headers['bridge-workspace'] === undefined) return problem(400, 'workspace-missing', 'Name the workspace in Bridge-Workspace.');
    if (entry.privilege !== null && !who.key.privileges.includes(entry.privilege)) {
      return problem(403, 'privilege-missing', `This needs the privilege ${entry.privilege}.`, { privilege: entry.privilege });
    }
    return asApp(method, path, headers, input, who.key.app);
  }

  /** The developer's routes on their apps (`/apps/{appId}/…`), each only for the workspace that owns the app. */
  function operator(method: string, path: string, url: URL, headers: Record<string, string>, input: Json, session: Session): Response {
    if (path === '/v2/app-registry/apps') {
      if (method === 'GET') return json(200, [...apps.values()].filter((app) => (app['owner'] as Json)['workspace'] === session.workspace));
      const app = { id: id('app'), name: input['name'], state: 'active', owner: { workspace: session.workspace }, addresses: input['addresses'] ?? [], defaultReturn: input['defaultReturn'] ?? null, profile: {}, trust: null, version: 1 };
      apps.set(app.id as string, app);
      return json(201, app);
    }
    const match = /^\/v2\/([a-z-]+)\/apps\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return notFound();
    const [, service, appId, rest = ''] = match as unknown as [string, string, string, string?];
    const app = apps.get(appId);
    if (!app || (app['owner'] as Json)['workspace'] !== session.workspace) return notFound();

    if (service === 'app-registry') {
      if (method === 'GET') return json(200, app);
      if (method === 'DELETE') {
        apps.delete(appId);
        return json(200, { deleted: appId });
      }
      for (const [field, value] of Object.entries(input)) {
        if (['logo', 'website', 'privacyPolicy', 'termsOfService'].includes(field)) (app['profile'] as Json)[field] = value;
        else app[field] = value;
      }
      const returns = (app['addresses'] as { url: string; uses: string[] }[]).filter((each) => each.uses.includes('sign-in-return')).map((each) => each.url);
      if (app['defaultReturn'] !== null && !returns.includes(app['defaultReturn'] as string)) return json(400, { message: 'defaultReturn must be one of the app\'s sign-in returns.' });
      return json(200, app);
    }

    if (service === 'identity-access') {
      if (rest === '/keys' && method === 'GET') return json(200, [...keys.values()].filter((k) => k.app === appId && !k.revoked).map(({ secret: _s, app: _a, ...view }) => ({ ...view, kind: 'app_key' })));
      if (rest === '/keys' && method === 'POST') {
        const made = { id: id('key'), app: appId, name: String(input['name']), privileges: (input['privileges'] as string[]) ?? [], secret: secret(), revoked: false, ...(typeof input['expiresInDays'] === 'number' ? { expiresInDays: input['expiresInDays'] } : {}) };
        keys.set(made.id, made);
        return json(201, { id: made.id, name: made.name, kind: 'app_key', privileges: made.privileges, expiresAt: new Date(clock + 86_400_000).toISOString(), revoked: false, key: `bk.${appId}.${made.id}.${made.secret}` });
      }
      const keyId = /^\/keys\/([^/]+)$/.exec(rest)?.[1];
      if (keyId && method === 'DELETE') {
        const found = keys.get(keyId);
        if (!found || found.app !== appId) return notFound();
        found.revoked = true;
        return json(204, undefined);
      }
      return notFound();
    }

    if (service === 'billing') return billing(method, rest, url, input, appId);
    if (service === 'flags') return flagRoutes(method, rest, headers, input, appId);
    return notFound();
  }

  function catalog(map: Map<string, Map<string, Json>>, method: string, rest: string, url: URL, input: Json, appId: string, kind: 'plans' | 'products'): Response {
    const items = perApp(map, appId, () => new Map<string, Json>());
    if (rest === `/${kind}`) {
      if (method === 'GET') return json(200, [...items.values()].filter((each) => url.searchParams.get('archived') === 'true' || !each['archived']));
      const key = String(input['key']);
      if (items.has(key)) return json(409, { message: `${key} exists.` });
      const made = { prices: [], features: [], limits: [], ...(kind === 'plans' ? { trial: null } : {}), description: '', ...input, archived: false };
      items.set(key, made);
      return json(201, made);
    }
    const m = new RegExp(`^/${kind}/([^/]+)(/archive|/deletion-preview)?$`).exec(rest);
    if (!m) return notFound();
    const [, key, sub] = m as unknown as [string, string, string?];
    const found = items.get(key);
    if (method === 'PUT' && sub === undefined) {
      const made = { key, prices: [], features: [], limits: [], trial: null, description: '', ...input, archived: found?.['archived'] ?? false };
      items.set(key, made);
      return json(200, made);
    }
    if (!found) return notFound();
    if (sub === '/archive') {
      found['archived'] = input['archived'] ?? true;
      return json(200, found);
    }
    if (sub === '/deletion-preview') return json(200, { key, holders: holders.get(key) ?? 0, deletable: (holders.get(key) ?? 0) === 0 });
    if (method === 'GET') return json(200, found);
    if (method === 'PATCH') {
      Object.assign(found, input);
      return json(200, found);
    }
    if (method === 'DELETE') {
      items.delete(key);
      return json(200, { deleted: key });
    }
    return notFound();
  }

  function billing(method: string, rest: string, url: URL, input: Json, appId: string): Response {
    if (rest.startsWith('/plans')) return catalog(plans, method, rest, url, input, appId, 'plans');
    if (rest.startsWith('/products')) return catalog(products, method, rest, url, input, appId, 'products');
    if (rest.startsWith('/metrics')) {
      const items = perApp(metrics, appId, () => new Map<string, Json>([['api.calls', { key: 'api.calls', name: 'API calls', kind: 'counter' }]]));
      if (rest === '/metrics') return json(200, [...items.values()]);
      const key = rest.slice('/metrics/'.length);
      if (method === 'PUT') {
        const made = { key, name: input['name'] ?? key, kind: input['kind'] };
        items.set(key, made);
        return json(200, made);
      }
      items.delete(key);
      return json(200, { deleted: key });
    }
    if (rest.startsWith('/taxes')) {
      const items = perApp(taxes, appId, () => new Map<string, Json>());
      if (rest === '/taxes') return json(200, [...items.values()]);
      const country = rest.slice('/taxes/'.length);
      if (!/^[A-Z]{2}$/.test(country)) return json(400, { message: 'A tax rate is for one country, by its two-letter ISO code, such as SE.' });
      if (method === 'PUT') {
        const made = { country, name: input['name'], basisPoints: input['basisPoints'] };
        items.set(country, made);
        return json(200, made);
      }
      items.delete(country);
      return json(200, { deleted: country });
    }
    if (rest === '/settings') {
      const current = perApp(settings, appId, () => ({ currency: null, paymentsAutoRedirect: false, returnUrl: null }) as Json);
      if (method === 'PATCH') Object.assign(current, input);
      return json(200, current);
    }
    if (rest === '/connection') {
      if (method === 'GET') return json(200, connections.get(appId) ?? null);
      const current = connections.get(appId);
      if (current) current['status'] = 'disconnected';
      return json(200, current ?? null);
    }
    return notFound();
  }

  function flagRoutes(method: string, rest: string, headers: Record<string, string>, input: Json, appId: string): Response {
    const items = perApp(flags, appId, () => new Map<string, Json>());
    if (rest === '/segments') return json(200, []);
    if (rest === '/flags') {
      if (method === 'GET') return json(200, [...items.values()]);
      const key = String(input['key']);
      if (items.has(key)) return json(409, { message: `${key} exists.` });
      const made = { id: id('flag'), description: '', state: 'off', valueType: 'boolean', onValue: true, offValue: false, rule: null, public: false, ...input, revision: 1 };
      items.set(key, made);
      return json(201, made);
    }
    const m = /^\/flags\/([^/]+)(\/kill|\/restore)?$/.exec(rest);
    if (!m) return notFound();
    const [, key, sub] = m as unknown as [string, string, string?];
    const found = items.get(key);
    if (!found) return notFound();
    if (sub === '/kill') {
      found['restoreState'] = found['state'] === 'off' ? found['restoreState'] : found['state'];
      found['state'] = 'off';
      found['revision'] = (found['revision'] as number) + 1;
      return json(200, found);
    }
    if (sub === '/restore') {
      found['state'] = found['restoreState'] ?? 'on';
      found['revision'] = (found['revision'] as number) + 1;
      return json(200, found);
    }
    if (method === 'GET') return json(200, found, { etag: `"${String(found['revision'])}"` });
    const match = headers['if-match'];
    if (method === 'PATCH' && match === undefined) return json(428, { message: 'Name the revision the change is made on, in If-Match.' });
    if (match !== undefined && match !== `"${String(found['revision'])}"`) return json(409, { message: 'The flag changed since it was read.' });
    if (method === 'DELETE') {
      items.delete(key);
      return json(200, { deleted: true });
    }
    Object.assign(found, input, { revision: (found['revision'] as number) + 1 });
    if (input['key'] !== undefined && input['key'] !== key) {
      items.delete(key);
      items.set(String(input['key']), found);
    }
    return json(200, found);
  }

  /** The routes version 2 offers only to the app's own server: an app key, acting on its app. */
  function asApp(method: string, path: string, headers: Record<string, string>, input: Json, appId: string): Response {
    if (path === '/v2/billing/connection' && method === 'POST') {
      pastedKeys.push(String(input['secretKey']));
      const made = { connector: input['connector'], status: 'active', account: 'acct_test', publicKey: input['publishableKey'] ?? null };
      connections.set(appId, made);
      return json(200, made);
    }
    const listOf = (map: Map<string, Json[]>) => perApp(map, appId, () => [] as Json[]);
    const crud = (list: Json[], base: string, idName: string): Response => {
      if (path === base && method === 'GET') return json(200, list);
      if (path === base && method === 'POST') {
        const made = { id: id(idName), privileges: [], ...input };
        list.push(made);
        return json(201, made);
      }
      const itemId = path.slice(base.length + 1);
      const index = list.findIndex((each) => each['id'] === itemId);
      if (index < 0) return notFound();
      if (method === 'PATCH') return json(200, Object.assign(list[index] as Json, input));
      list.splice(index, 1);
      return json(200, { deleted: itemId });
    };
    if (path.startsWith('/v2/accounts/roles')) return crud(listOf(roles), '/v2/accounts/roles', 'role');
    if (path.startsWith('/v2/accounts/privileges')) return crud(listOf(privileges), '/v2/accounts/privileges', 'privilege');
    if (path === '/v2/accounts/workspaces') return json(200, listOf(workspaces));
    if (path.startsWith('/v2/accounts/members')) {
      const workspace = headers['bridge-workspace'] as string;
      if (!listOf(workspaces).some((each) => each['id'] === workspace)) return notFound();
      const list = perApp(members, `${appId}/${workspace}`, () => [] as Json[]);
      if (path === '/v2/accounts/members') return json(200, list);
      const memberId = path.slice('/v2/accounts/members/'.length);
      const found = list.find((each) => each['id'] === memberId);
      if (!found) return notFound();
      if (method === 'GET') return json(200, found);
      if (method === 'PATCH') return json(200, Object.assign(found, input));
      list.splice(list.indexOf(found), 1);
      return json(200, { deleted: memberId });
    }
    return notFound();
  }

  async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    if (url.origin !== BASE) throw new TypeError(`fetch failed: ${url.origin} is not the fake Bridge`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name.toLowerCase()] = value));
    const raw = typeof init.body === 'string' ? init.body : '';
    const body = raw === '' ? undefined : (JSON.parse(raw) as Json);
    requests.push({ method, path: url.pathname, query: url.searchParams, headers, body });
    return handle(method, url, headers, body);
  }

  return {
    fetch: fakeFetch,
    requests,
    violations,
    revoked,
    pastedKeys,
    keys,
    apps,
    sessions,
    holders,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** Bridge stops taking every access token it gave (a key rotation), while the sessions go on. */
    dropAccessTokens() {
      accessTokens.clear();
    },
    addPerson(person: Partial<Person> & { email: string; password: string }): Person {
      const made: Person = { id: id('person'), firstName: 'Ada', lastName: 'Lovelace', workspaces: [{ id: 'ws-1', name: 'Acme' }], ...person };
      people.set(made.email, made);
      return made;
    },
    addApp(fields: { name: string; owner: string }): string {
      const appId = id('app');
      apps.set(appId, { id: appId, name: fields.name, state: 'active', owner: { workspace: fields.owner }, addresses: [], defaultReturn: null, profile: {}, trust: null, version: 1 });
      return appId;
    },
    addWorkspace(appId: string, workspace: Json, people: Json[] = []) {
      perApp(workspaces, appId, () => [] as Json[]).push(workspace);
      perApp(members, `${appId}/${String(workspace['id'])}`, () => [] as Json[]).push(...people);
    },
    roles: (appId: string) => perApp(roles, appId, () => [] as Json[]),
    plans: (appId: string) => perApp(plans, appId, () => new Map<string, Json>()),
    flags: (appId: string) => perApp(flags, appId, () => new Map<string, Json>()),
    /** What Bridge's sign-in page does in hand-off mode: sign in with the program's challenge, never trade the code. */
    async handoff(params: URLSearchParams, person: { email: string; password: string; workspace?: string }): Promise<string> {
      const answer = signIn({ email: person.email, password: person.password, code_challenge: params.get('code_challenge'), code_challenge_method: params.get('code_challenge_method'), ...(person.workspace ? { workspace: person.workspace } : {}) });
      const body = (await answer.json()) as { code?: string };
      if (!body.code) throw new Error('The fake sign-in page could not sign in.');
      return body.code;
    },
  };
}

export type FakeBridge = ReturnType<typeof createFakeBridge>;
export { V2 };
