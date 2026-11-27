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
  /** False when the sign-in said `delete: false`: the person's session then holds no delete privilege. */
  canDelete?: boolean;
}

type Json = Record<string, unknown>;

interface SignInRequest {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  used: boolean;
}

/** The Bridge App's registered loopback returns, `http://127.0.0.1/callback` and `http://[::1]/callback`, on any port. */
const LOOPBACK_RETURN = /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/callback$/;

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
  const codes = new Map<string, { session: Omit<Session, 'ended'>; challenge: string; redirectUri: string | null }>();
  const flows = new Map<string, { person: Person; challenge: string; request: SignInRequest | null; canDelete?: boolean }>();
  /** Sign-in requests by id: the CLI's challenge, state and loopback return, held by Bridge. */
  const signInRequests = new Map<string, SignInRequest>();
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
  const brandings = new Map<string, Json>();
  const signInSettings = new Map<string, Json>();
  const eventLogs = new Map<string, Json[]>();
  const senders = new Map<string, Json | null>();
  const schedules = new Map<string, Json[]>();
  const appUsers = new Map<string, Json[]>();
  /** Each User's passkeys, by `<app>/<user>` (TBP-861), and the provider credentials saved, by `<app>/<provider>`. */
  const userPasskeyLists = new Map<string, Json[]>();
  const savedSecrets = new Map<string, Json>();
  /** Each User's connected tools (TBP-854) by `<app>/<user>`, and how many browser sessions they have. */
  const userConnectionLists = new Map<string, Json[]>();
  const browserSessions = new Map<string, number>();
  /** A server from before Assistants and CLI: no `tools`, no `mcp`, no connections routes. */
  let olderServer = false;
  /** Invites by `bridge/<workspace>` (the developer's own) or `<app>/<workspace>`. */
  const invites = new Map<string, Json[]>();
  /** Why Bridge refuses to send invites now: no email-links address, or too many. */
  let inviteRefusal: 'no-email-links' | 'too-many' | null = null;
  let ids = 0;
  const id = (prefix: string) => `${prefix}-${String(++ids)}`;

  const perApp = <T>(map: Map<string, T>, app: string, make: () => T): T => {
    if (!map.has(app)) map.set(app, make());
    return map.get(app) as T;
  };

  /** What Identity and Access knows for TBP-872: whether the password rules are at least Recommended and how many users must choose a new one. */
  const production = new Map<string, Json>();
  /** How many passkeys each app's users made on its main address's domain. */
  const passkeys = new Map<string, number>();
  const domainOf = (origin: string | null): string | null => (origin === null ? null : new URL(origin).hostname.split('.').slice(-2).join('.'));
  const isLocal = (origin: string | null) => origin !== null && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
  /** The app's "Your app" settings, kept on the record; an app made by `addApp` has none until read, and then production with no main address. */
  function yourAppOf(app: Json): Json {
    if (app['yourApp'] === undefined) app['yourApp'] = { mode: 'production', main: null, signIn: { location: 'hosted', path: '/auth/login', returnPath: '/auth/oauth-callback', emailLinks: null } };
    return app['yourApp'] as Json;
  }
  const productionRules = (main: string | null) => [
    { rule: 'main-address-is-a-real-website', text: 'Main address is a real website', passes: main !== null && !isLocal(main) && /^https:/.test(main) },
    { rule: 'password-rules-at-least-recommended', text: 'Password rules at least Recommended', passes: null as boolean | null },
  ];
  function withYourApp(app: Json): Json {
    const mine = yourAppOf(app);
    const main = mine['main'] as string | null;
    const choices = (app['addresses'] as { url: string; uses: string[] }[]).filter((each) => each.uses.includes('browser-origin') && !each.url.includes('*')).map((each) => each.url);
    const { mcp, ...rest } = app;
    return { ...rest, yourApp: { mode: mine['mode'], main, mainChoices: choices, passkeyDomain: domainOf(main), signIn: { ...(mine['signIn'] as Json), emailLinksOpenOn: null }, productionRules: productionRules(main), ...(olderServer ? {} : { mcp: mcp ?? [] }) } };
  }

  let signInPage: string | null = null;
  /** Sign-in with a short code (RFC 8628): off until a test switches it on, as an app's `tools.shortCode`. */
  let deviceCodes = false;
  interface DeviceGrant { userCode: string; status: 'pending' | 'approved' | 'denied' | 'used'; session: Omit<Session, 'ended'> | null; expiresAt: number; slowDown: number }
  const deviceGrants = new Map<string, DeviceGrant>();
  /** Called on each poll: what a test does on the other device meanwhile. */
  let onDevicePoll: ((userCode: string, polls: number) => void) | null = null;
  let devicePolls = 0;
  /** What the server's protected resource metadata names as its issuer, when a test changes it. */
  let protectedResourceIssuer: string | null = null;

  function metadata(): Json {
    const text = JSON.stringify(DISCOVERY.document).replaceAll('{base}', BASE).replaceAll('{app}', BRIDGE_APP);
    const document = JSON.parse(text) as Json;
    // Listed only for an app whose page signs in for programs: the page and where its sign-in requests start.
    if (signInPage !== null) Object.assign((document['bridge_endpoints'] as Json)['2'] as Json, { sign_in_page: signInPage, sign_in_requests: `${V2}/identity-access/apps/${BRIDGE_APP}/sign-in-requests` });
    if (deviceCodes) {
      const at = `${V2}/identity-access/apps/${BRIDGE_APP}/device-authorization`;
      document['device_authorization_endpoint'] = at;
      document['grant_types_supported'] = [...(document['grant_types_supported'] as string[]), 'urn:ietf:params:oauth:grant-type:device_code'];
      Object.assign((document['bridge_endpoints'] as Json)['2'] as Json, { device_authorization: at, device_request: `${V2}/identity-access/apps/${BRIDGE_APP}/device/request` });
    }
    return document;
  }

  function issue(sessionId: string): Json {
    const session = sessions.get(sessionId) as Session;
    const access = `at-${secret()}`;
    const refresh = `rt-${secret()}`;
    accessTokens.set(access, { session: sessionId, exp: clock + 300_000 });
    refreshTokens.set(refresh, { session: sessionId, used: false });
    return { access_token: access, token_type: 'Bearer', expires_in: 300, refresh_token: refresh, id_token: 'unused', ...(session.workspace === null ? {} : { workspace: session.workspace }) };
  }

  function codeFor(person: Person, workspace: string | null, challenge: string, request: SignInRequest | null = null, canDelete?: boolean): Response {
    const code = `code-${secret()}`;
    codes.set(code, { session: { person, workspace, authTime: clock, ...(canDelete === undefined ? {} : { canDelete }) }, challenge: request?.challenge ?? challenge, redirectUri: request?.redirectUri ?? null });
    return json(200, request === null ? { code } : { code, redirect_uri: request.redirectUri, state: request.state });
  }

  /** A sign-in request, as Bridge makes one for the Bridge App: only for one of its loopback returns, on any port. */
  function startRequest(body: Json): Response {
    if (body['client_id'] !== undefined && body['client_id'] !== BRIDGE_APP) return json(400, { error: 'invalid_client' });
    if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body['code_challenge'])) return json(400, { error: 'invalid_request' });
    if (typeof body['state'] !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(body['state'])) return json(400, { error: 'invalid_request' });
    const redirectUri = body['redirect_uri'];
    if (typeof redirectUri !== 'string' || !LOOPBACK_RETURN.test(redirectUri) || new URL(redirectUri).href !== redirectUri) {
      return json(400, { error: 'invalid_request', error_description: "redirect_uri is not one of the app's registered sign-in returns." });
    }
    const handle = `request-${secret()}`;
    signInRequests.set(handle, { redirectUri, challenge: body['code_challenge'], state: body['state'], used: false });
    return json(201, { request: handle, expires_in: 600 });
  }

  /** The challenge endpoint: what the CLI's password sign-in and Bridge's sign-in page (on a sign-in request) both call. */
  function signIn(body: Json): Response {
    if (typeof body['flow'] === 'string') {
      const flow = flows.get(body['flow']);
      if (!flow) return json(400, { error: 'flow_expired' });
      flows.delete(body['flow']);
      const workspace = String(body['workspace']);
      if (!flow.person.workspaces.some((each) => each.id === workspace)) return json(403, { error: 'access_denied', reason: 'not_a_member' });
      return codeFor(flow.person, workspace, flow.challenge, flow.request, flow.canDelete);
    }
    // `delete` is for a password sign-in only: a boolean, never on a sign-in request (the approval decides there).
    if (body['delete'] !== undefined && (typeof body['delete'] !== 'boolean' || body['request'] !== undefined)) return json(400, { error: 'invalid_request' });
    const canDelete = typeof body['delete'] === 'boolean' ? body['delete'] : undefined;
    // On a sign-in request, the request's challenge and return; the page names neither.
    let request: SignInRequest | null = null;
    if (body['request'] !== undefined) {
      request = signInRequests.get(String(body['request'])) ?? null;
      if (request === null || request.used || body['code_challenge'] !== undefined || body['redirect_uri'] !== undefined) return json(400, { error: 'invalid_request_uri' });
    } else if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string') return json(400, { error: 'invalid_request' });
    const challenge = request?.challenge ?? String(body['code_challenge']);
    const person = people.get(String(body['email']));
    if (!person || person.password !== body['password']) return json(400, { error: 'wrong_credentials' });
    const requested = typeof body['workspace'] === 'string' ? body['workspace'] : null;
    if (request !== null) request.used = true;
    if (requested === null && person.workspaces.length > 1) {
      const handle = `flow-${secret()}`;
      flows.set(handle, { person, challenge, request, ...(canDelete === undefined ? {} : { canDelete }) });
      return json(200, { next: 'workspace', flow: handle, workspaces: person.workspaces.map((each) => ({ ...each, logo: null })) });
    }
    const workspace = requested ?? person.workspaces[0]?.id ?? null;
    if (workspace !== null && !person.workspaces.some((each) => each.id === workspace)) return json(403, { error: 'access_denied', reason: 'not_a_member' });
    return codeFor(person, workspace, challenge, request, canDelete);
  }

  function token(body: Json): Response {
    if (body['client_id'] !== undefined && body['client_id'] !== BRIDGE_APP) return json(400, { error: 'invalid_client' });
    if (body['grant_type'] === 'authorization_code') {
      const found = codes.get(String(body['code']));
      codes.delete(String(body['code']));
      if (!found || s256(String(body['code_verifier'])) !== found.challenge) return json(400, { error: 'invalid_grant', error_description: 'The code is not valid.' });
      // A code made for a return is traded only with that same redirect_uri (RFC 6749, 4.1.3).
      if (found.redirectUri !== null && body['redirect_uri'] !== found.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'The code is not valid.' });
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
    if (body['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
      const grant = deviceGrants.get(String(body['device_code']));
      if (!grant) return json(400, { error: 'invalid_grant', error_description: 'The device code is not valid.' });
      devicePolls += 1;
      onDevicePoll?.(grant.userCode, devicePolls);
      if (grant.slowDown > 0) {
        grant.slowDown -= 1;
        return json(400, { error: 'slow_down', error_description: 'Polling too fast.' });
      }
      if (grant.status === 'used') return json(400, { error: 'invalid_grant', error_description: 'This code was already used.' });
      if (grant.status === 'denied') return json(400, { error: 'access_denied', error_description: 'The sign-in was denied.' });
      if (clock >= grant.expiresAt) return json(400, { error: 'expired_token', error_description: 'The code expired.' });
      if (grant.status === 'pending' || grant.session === null) return json(400, { error: 'authorization_pending', error_description: 'Waiting for approval.' });
      grant.status = 'used';
      const sessionId = id('session');
      sessions.set(sessionId, { ...grant.session, ended: false });
      return json(200, issue(sessionId), { 'cache-control': 'no-store' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function deviceAuthorization(body: Json): Response {
    if (!deviceCodes) return json(400, { error: 'unauthorized_client', error_description: 'This app does not allow sign-in with a short code. Sign in through the browser.' });
    if (body['client_id'] !== undefined && body['client_id'] !== BRIDGE_APP) return json(400, { error: 'invalid_client' });
    const deviceCode = `dc-${secret()}`;
    const userCode = 'WDJB-MJHT';
    deviceGrants.set(deviceCode, { userCode, status: 'pending', session: null, expiresAt: clock + 600_000, slowDown: 0 });
    return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: 'https://dashboard.test/connect/device/', verification_uri_complete: `https://dashboard.test/connect/device/?code=${userCode}`, expires_in: 600, interval: 5 });
  }

  const grantOf = (userCode: string): DeviceGrant => {
    const found = [...deviceGrants.values()].find((each) => each.userCode === userCode && each.status === 'pending');
    if (found === undefined) throw new Error(`No pending code ${userCode}`);
    return found;
  };

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
    // The server's protected resource metadata (RFC 9728), naming the Bridge App's issuer: what `--server` reads.
    if (method === 'GET' && path === '/.well-known/oauth-protected-resource') return json(200, { resource: `${BASE}/mcp`, authorization_servers: [protectedResourceIssuer ?? ISSUER] });

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
    if (method === 'POST' && path === `${ia}/sign-in-requests`) return startRequest(input);
    if (method === 'POST' && path === `${ia}/token`) return token(input);
    if (method === 'POST' && path === `${ia}/device-authorization`) return deviceAuthorization(input);
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
      // A session made with `delete: false` holds no delete privilege: a DELETE is refused, whatever the person holds.
      if (method === 'DELETE' && who.session.canDelete === false) {
        return problem(403, 'privilege-missing', `This needs the privilege ${entry.privilege ?? 'to delete'}, which this sign-in does not hold.`, { privilege: entry.privilege });
      }
      const stale = clock - who.session.authTime > 300_000;
      const own = inviteRoutes(method, path, input, `bridge/${String(who.session.workspace)}`, who.session.person.id, stale);
      if (own !== null) return own;
      return operator(method, path, url, headers, input, who.session);
    }
    if (entry.requires.includes('workspace') && headers['bridge-workspace'] === undefined) return problem(400, 'workspace-missing', 'Name the workspace in Bridge-Workspace.');
    if (entry.privilege !== null && !who.key.privileges.includes(entry.privilege)) {
      return problem(403, 'privilege-missing', `This needs the privilege ${entry.privilege}.`, { privilege: entry.privilege });
    }
    return asApp(method, path, headers, input, who.key.app);
  }

  /** Invites in one workspace: list the open ones, send (or send again, with a new link), revoke. */
  function inviteRoutes(method: string, path: string, input: Json, where: string, invitedBy: string | null, stale = false): Response | null {
    if (!path.startsWith('/v2/accounts/invites')) return null;
    const list = perApp(invites, where, () => [] as Json[]);
    if (path === '/v2/accounts/invites' && method === 'GET') return json(200, list.filter((each) => each['state'] === 'open'));
    if (path === '/v2/accounts/invites' && method === 'POST') {
      if (inviteRefusal === 'no-email-links') return problem(409, 'conflict', 'The app has no email-links address, so its emails cannot carry a link.');
      if (inviteRefusal === 'too-many') return problem(429, 'rate-limited', 'Too many invites from this workspace for now.', {}, { 'retry-after': '3600' });
      // An Owner invite by a person needs a fresh sign-in (the identity re-check); an app's server key passes its own checks.
      if (input['role'] === 'OWNER' && stale) return problem(401, 'identity-recheck', 'Sign in again to confirm it is you.', { maxAge: 300 });
      const email = String(input['email']).toLowerCase();
      const fields = { role: input['role'] ?? 'MEMBER', ...(input['firstName'] === undefined ? {} : { firstName: input['firstName'] }), ...(input['lastName'] === undefined ? {} : { lastName: input['lastName'] }), state: 'open', expiresAt: new Date(clock + 30 * 86_400_000).toISOString(), invitedBy };
      const existing = list.find((each) => each['email'] === email);
      if (existing) return json(201, Object.assign(existing, fields));
      const made = { id: id('inv'), email, createdAt: new Date(clock).toISOString(), ...fields };
      list.push(made);
      return json(201, made);
    }
    const found = list.find((each) => path === `/v2/accounts/invites/${String(each['id'])}` && each['state'] === 'open');
    if (method === 'DELETE' && found) {
      found['state'] = 'revoked';
      return json(200, { revoked: true });
    }
    return notFound();
  }

  /** The developer's routes on their apps (`/apps/{appId}/…`), each only for the workspace that owns the app. */
  function operator(method: string, path: string, url: URL, headers: Record<string, string>, input: Json, session: Session): Response {
    if (path === '/v2/app-registry/apps') {
      if (method === 'GET') return json(200, [...apps.values()].filter((app) => (app['owner'] as Json)['workspace'] === session.workspace));
      const given = ((input['addresses'] as { url: string; uses: string[] }[] | undefined) ?? []).map((each) => ({ url: each.url, uses: [...each.uses] }));
      const main = typeof input['main'] === 'string' ? input['main'] : null;
      if (main !== null && !given.some((each) => each.url === main)) given.push({ url: main, uses: ['browser-origin'] });
      const app = { id: id('app'), name: input['name'], state: 'active', owner: { workspace: session.workspace }, addresses: given, defaultReturn: input['defaultReturn'] ?? null, profile: {}, trust: null, version: 1 };
      Object.assign(app, { yourApp: { mode: input['mode'] ?? (main !== null && /localhost/.test(main) ? 'development' : 'production'), main, signIn: { location: 'app', path: '/auth/login', returnPath: '/auth/oauth-callback', emailLinks: null } } });
      apps.set(app.id as string, app);
      return json(201, withYourApp(app));
    }
    const match = /^\/v2\/([a-z-]+)\/apps\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return notFound();
    const [, service, appId, rest = ''] = match as unknown as [string, string, string, string?];
    const app = apps.get(appId);
    if (!app || (app['owner'] as Json)['workspace'] !== session.workspace) return notFound();

    if (service === 'app-registry' && rest === '/branding') {
      const current = perApp(brandings, appId, () => ({ scheme: 'auto', colors: {}, radius: 'medium', font: 'system', revision: 1 }) as Json);
      if (method === 'GET') return json(200, current, { etag: `"${String(current['revision'])}"` });
      const match = headers['if-match'];
      if (match === undefined) return json(428, { message: 'Name the revision the change is made on, in If-Match.' });
      if (match !== `"${String(current['revision'])}"`) return json(412, { message: 'The branding changed since it was read.' });
      for (const [field, value] of Object.entries(input)) current[field] = field === 'colors' ? { ...(current['colors'] as Json), ...(value as Json) } : value;
      current['revision'] = (current['revision'] as number) + 1;
      return json(200, current);
    }
    if (service === 'app-registry' && rest === '/mode') {
      const mine = yourAppOf(app);
      if (method === 'GET') return json(200, { mode: mine['mode'], main: mine['main'], rules: productionRules(mine['main'] as string | null), canSwitchToProduction: productionRules(mine['main'] as string | null).every((rule) => rule.passes !== false), version: app['version'] });
      if (input['confirm'] !== true) return json(409, { message: 'Switching needs a confirmation: send confirm: true.' });
      if (input['mode'] === 'production' && productionRules(mine['main'] as string | null).some((rule) => rule.passes !== true && rule.rule === 'main-address-is-a-real-website')) {
        return json(409, { message: 'The app can go to production once its main address is a real website, not localhost.' });
      }
      mine['mode'] = input['mode'];
      return json(200, withYourApp(app));
    }
    if (service === 'identity-access' && rest === '/sign-in-settings/production') {
      return json(200, { mode: yourAppOf(app)['mode'], passwordRules: { passes: perApp(production, appId, () => ({ passes: true, users: 0 }) as Json)['passes'], preset: 'basic', required: 'recommended' }, usersToChooseNewPassword: perApp(production, appId, () => ({ passes: true, users: 0 }) as Json)['users'] });
    }
    if (service === 'identity-access' && rest === '/sign-in-settings/passkey-impact') {
      const from = domainOf(yourAppOf(app)['main'] as string | null);
      const to = domainOf(url.searchParams.get('main'));
      return json(200, { from, to, stopWorking: from === null || from === to ? 0 : (passkeys.get(appId) ?? 0) });
    }
    if (service === 'app-registry') {
      if (method === 'GET') return json(200, withYourApp(app));
      if (method === 'DELETE') {
        apps.delete(appId);
        return json(200, { deleted: appId });
      }
      if (input['main'] !== undefined) {
        const was = domainOf(yourAppOf(app)['main'] as string | null);
        const next = domainOf(input['main'] as string | null);
        if (!(app['addresses'] as { url: string }[]).some((each) => each.url === input['main'])) return json(400, { message: 'The main address must be one of the app\'s listed addresses.' });
        if (was !== null && was !== next && input['confirmPasskeys'] !== true) return json(409, { message: 'Passkeys belong to the main address\'s domain.' });
        yourAppOf(app)['main'] = input['main'];
      }
      const mine = yourAppOf(app);
      if (input['signIn'] !== undefined) mine['signIn'] = { ...(mine['signIn'] as Json), ...(input['signIn'] as Json) };
      const mcp = input['mcp'] as string[] | undefined;
      if (mcp !== undefined && (mcp.length > 10 || mcp.some((each) => !/^https:\/\/[^*?#]+$/.test(each)))) return json(400, { message: 'mcp lists at most 10 https URLs, with no wildcard, query or fragment.' });
      for (const [field, value] of Object.entries(input)) {
        if (['main', 'confirmPasskeys', 'signIn', 'mode'].includes(field)) continue;
        if (['logo', 'website', 'privacyPolicy', 'termsOfService'].includes(field)) (app['profile'] as Json)[field] = value;
        else app[field] = value;
      }
      const returns = (app['addresses'] as { url: string; uses: string[] }[]).filter((each) => each.uses.includes('sign-in-return')).map((each) => each.url);
      if (app['defaultReturn'] !== null && !returns.includes(app['defaultReturn'] as string)) return json(400, { message: 'defaultReturn must be one of the app\'s sign-in returns.' });
      return json(200, withYourApp(app));
    }

    const settingsOf = () =>
      perApp(
        signInSettings,
        appId,
        () =>
          ({
            methods: { password: true, magicLink: false, passkeys: false },
            social: { google: false, linkedin: false, facebook: false, github: false, azure: false },
            secondStep: false,
            providers: Object.fromEntries(['google', 'linkedin', 'facebook', 'github', 'azure'].map((p) => [p, { name: p === 'azure' ? 'Microsoft' : p, configured: false, clientId: null, tenantId: null, returnAddress: `${ISSUER.replace(BRIDGE_APP, appId)}/federated/${p}/return` }])),
            signUp: true,
            signUpPlan: null,
            lifetimes: { accessTokenSeconds: 300, sessionIdleSeconds: 1_209_600, sessionAbsoluteSeconds: 2_592_000 },
            password: { preset: 'basic', minLength: 8 },
            passwordFacts: { badge: null, commonPasswords: { updated: '2026-11-27' }, productionFloor: { kept: true, preset: 'basic' } },
            bounds: { lifetimes: { accessTokenSeconds: { min: 60, max: 300 } } },
            ...(olderServer ? {} : { tools: { anyAssistant: true, assistants: [], shortCode: false } }),
          }) as Json,
      );
    // A provider's credentials (TBP-134, TBP-859): kept as configured, never read back.
    const providerAt = /^\/sign-in-settings\/providers\/([a-z]+)$/.exec(rest);
    if (service === 'identity-access' && providerAt !== null && method === 'PUT') {
      const current = settingsOf();
      const provider = providerAt[1] as string;
      const saved = (current['providers'] as Record<string, Json>)[provider];
      if (saved === undefined) return notFound();
      if (provider !== 'azure' && input['tenantId'] !== undefined) return json(400, { message: 'Only Microsoft takes a tenantId.' });
      const tenant = (input['tenantId'] as string | undefined) ?? 'common';
      savedSecrets.set(`${appId}/${provider}`, input);
      Object.assign(saved, { configured: true, clientId: input['clientId'], ...(provider === 'azure' ? { tenantId: tenant, audience: ({ common: 'any', organizations: 'work', consumers: 'personal' } as Record<string, string>)[tenant] ?? 'directory', secretExpiresAt: (input['secretExpiresAt'] as string | undefined) ?? '2028-11-27T00:00:00.000Z', secretExpiry: 'ok' } : {}) });
      return json(200, current);
    }
    // A User's connected tools and every session (TBP-854).
    const connectionAt = /^\/users\/([^/]+)\/(connections|sessions)(?:\/([^/]+))?$/.exec(rest);
    if (service === 'identity-access' && connectionAt !== null && !olderServer) {
      const key = `${appId}/${connectionAt[1] as string}`;
      const own = perApp(userConnectionLists, key, () => [] as Json[]);
      if (connectionAt[2] === 'sessions' && method === 'DELETE' && connectionAt[3] === undefined) {
        const ended = own.length + (browserSessions.get(key) ?? 0);
        own.splice(0);
        browserSessions.set(key, 0);
        return json(200, { ended });
      }
      if (connectionAt[2] === 'connections' && connectionAt[3] === undefined) {
        if (method === 'GET') return json(200, own);
        if (method === 'DELETE') return json(200, { ended: own.splice(0).length });
      }
      if (connectionAt[2] === 'connections' && method === 'DELETE') {
        const at = own.findIndex((each) => each['id'] === connectionAt[3]);
        if (at < 0) return notFound();
        own.splice(at, 1);
        return json(204, undefined);
      }
      return notFound();
    }
    // A User's passkeys (TBP-861).
    const passkeyAt = /^\/users\/([^/]+)\/passkeys(?:\/([^/]+))?$/.exec(rest);
    if (service === 'identity-access' && passkeyAt !== null) {
      const own = perApp(userPasskeyLists, `${appId}/${passkeyAt[1] as string}`, () => [] as Json[]);
      if (method === 'GET' && passkeyAt[2] === undefined) return json(200, own);
      if (method === 'DELETE' && passkeyAt[2] !== undefined) {
        const at = own.findIndex((each) => each['id'] === passkeyAt[2]);
        if (at < 0) return notFound();
        own.splice(at, 1);
        return json(204, undefined);
      }
      return notFound();
    }
    if (service === 'identity-access' && rest === '/sign-in-settings') {
      const current = settingsOf();
      if (method === 'GET') return json(200, current);
      for (const [name, on] of Object.entries((input['social'] as Json | undefined) ?? {})) {
        if (on === true && ((current['providers'] as Record<string, Json>)[name]?.['configured'] !== true)) return json(400, { message: `Add ${name}'s client ID and secret first.` });
      }
      const password = input['password'] as Json | undefined;
      if (password !== undefined && perApp(production, appId, () => ({ passes: true, users: 0 }) as Json)['floor'] === 'recommended' && (password['preset'] === 'basic' || (typeof password['minLength'] === 'number' && password['minLength'] < 12))) {
        return json(400, { message: 'In production the password rules are at least Recommended (12 characters, common passwords refused, not holding the address).' });
      }
      const rules = password === undefined ? current['password'] : password['preset'] === 'custom' ? password : { preset: password['preset'], minLength: password['preset'] === 'strict' ? 15 : password['preset'] === 'basic' ? 8 : 12 };
      const badge = password === undefined ? (current['passwordFacts'] as Json)['badge'] : ['recommended', 'strict'].includes(String((rules as Json)['preset'])) ? 'nist' : (rules as Json)['preset'] === 'compliance' ? 'audit' : null;
      const next = {
        ...current,
        ...input,
        password: rules,
        passwordFacts: { ...(current['passwordFacts'] as Json), badge },
        methods: { ...(current['methods'] as Json), ...((input['methods'] as Json | undefined) ?? {}) },
        social: { ...(current['social'] as Json), ...((input['social'] as Json | undefined) ?? {}) },
        lifetimes: { ...(current['lifetimes'] as Json), ...((input['lifetimes'] as Json | undefined) ?? {}) },
        ...(input['tools'] === undefined ? {} : { tools: { ...(current['tools'] as Json), ...(input['tools'] as Json) } }),
      };
      if (!Object.values(next['methods'] as Json).some(Boolean) && !Object.values(next['social'] as Json).some(Boolean)) return json(400, { message: 'At least one sign-in method stays on.' });
      Object.assign(current, next);
      return json(200, current);
    }
    if (service === 'events-and-logs' && rest === '/events') {
      let list = perApp(eventLogs, appId, () => [] as Json[]);
      const type = url.searchParams.get('type');
      if (type !== null) list = list.filter((each) => each['type'] === type);
      const workspace = url.searchParams.get('workspaceId');
      if (workspace !== null) list = list.filter((each) => each['workspaceId'] === workspace);
      const from = url.searchParams.get('from');
      if (from !== null) list = list.filter((each) => String(each['time']) >= from);
      return json(200, { events: list.slice(0, Number(url.searchParams.get('limit') ?? 100)), next: null });
    }
    if (service === 'communication' && rest === '/sender') {
      if (method === 'GET') return json(200, perApp(senders, appId, () => null));
      senders.set(appId, { ...input, state: 'pending' });
      return json(200, senders.get(appId));
    }
    if (service === 'billing' && rest === '/connection/health') return json(200, { connected: connections.has(appId), status: connections.get(appId)?.['status'] ?? 'not-connected' });
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

    if (service === 'accounts') return operatorAccounts(method, rest, headers, input, appId, session.person.id, clock - session.authTime > 300_000, url);
    if (service === 'billing') return billing(method, rest, url, input, appId);
    if (service === 'flags') return flagRoutes(method, rest, headers, input, appId, url);
    return notFound();
  }

  /**
   * The operator routes for the app's roles, privileges, workspaces, members and invites: the same
   * handlers as the app's server's key routes, with the workspace in the path instead of a header.
   */
  function operatorAccounts(method: string, rest: string, headers: Record<string, string>, input: Json, appId: string, personId: string, stale: boolean, url: URL): Response {
    const inWorkspace = /^\/workspaces\/([^/]+)(\/(?:members|invites)(?:\/.*)?)$/.exec(rest);
    if (inWorkspace) {
      const [, workspace, tail] = inWorkspace as unknown as [string, string, string];
      return asApp(method, `/v2/accounts${tail}`, { ...headers, 'bridge-workspace': workspace }, input, appId, personId, stale);
    }
    if (/^\/(roles|privileges)(\/[^/]+)?$/.test(rest) || (rest === '/workspaces' && method === 'GET')) return asApp(method, `/v2/accounts${rest}`, headers, input, appId, personId, stale);
    const list = perApp(workspaces, appId, () => [] as Json[]);
    if (rest === '/workspaces' && method === 'POST') {
      const owner = input['owner'] as { email: string };
      const made = { id: id('ws'), name: input['name'] ?? null, locale: input['locale'] ?? null, logo: null, state: 'active', owner, createdAt: new Date(clock).toISOString() };
      list.push(made);
      perApp(members, `${appId}/${made.id}`, () => [] as Json[]).push({ id: id('member'), user: { id: id('user'), email: owner.email, firstName: null, lastName: null }, role: 'OWNER', status: 'active' });
      return json(201, made);
    }
    if (rest === '/users' && method === 'GET') {
      const email = url.searchParams.get('email');
      return json(200, perApp(appUsers, appId, () => [] as Json[]).filter((each) => email === null || String(each['email']).toLowerCase() === email.toLowerCase()));
    }
    const one = /^\/workspaces\/([^/]+)$/.exec(rest);
    if (one !== null) {
      const found = list.find((each) => each['id'] === one[1]);
      if (!found) return notFound();
      if (method === 'GET') return json(200, found);
      if (method === 'PATCH') return json(200, Object.assign(found, input));
      list.splice(list.indexOf(found), 1);
      return json(200, { ...found, state: 'deletion_scheduled', deleteAt: new Date(clock + 30 * 86_400_000).toISOString() });
    }
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
      if (method === 'POST') return pasteStripeKey(input, appId);
      if (method === 'GET') return json(200, connections.get(appId) ?? null);
      const current = connections.get(appId);
      if (current) current['status'] = 'disconnected';
      return json(200, current ?? null);
    }
    return notFound();
  }

  function flagRoutes(method: string, rest: string, headers: Record<string, string>, input: Json, appId: string, url: URL): Response {
    const items = perApp(flags, appId, () => new Map<string, Json>());
    if (rest === '/segments') return json(200, []);
    if (rest === '/export') return json(200, { version: 1, flags: [...items.values()].map(({ id: _i, revision: _r, ...each }) => each).sort((a, b) => String(a['key']).localeCompare(String(b['key']))) });
    if (rest === '/import' && method === 'POST') {
      const report = { created: [] as string[], updated: [] as { key: string; fields: string[] }[], unchanged: [] as string[], extraneous: [] as string[] };
      const given = new Set<string>();
      for (const each of input['flags'] as Json[]) {
        const key = String(each['key']);
        given.add(key);
        const found = items.get(key);
        if (found === undefined) {
          report.created.push(key);
          if (input['dryRun'] !== true) items.set(key, { id: id('flag'), description: '', state: 'off', valueType: 'boolean', onValue: true, offValue: false, rule: null, public: false, ...each, revision: 1 });
          continue;
        }
        const fields = Object.keys(each).filter((field) => JSON.stringify(each[field]) !== JSON.stringify(found[field]));
        if (fields.length === 0) report.unchanged.push(key);
        else {
          report.updated.push({ key, fields });
          if (input['dryRun'] !== true) Object.assign(found, each, { revision: (found['revision'] as number) + 1 });
        }
      }
      report.extraneous = [...items.keys()].filter((key) => !given.has(key) && !report.created.includes(key));
      return json(200, report);
    }
    if (rest === '/schedules' && method === 'GET') return json(200, perApp(schedules, appId, () => [] as Json[]).filter((each) => url.searchParams.get('flag') === null || each['flag'] === url.searchParams.get('flag')));
    const scheduleId = /^\/schedules\/([^/]+)$/.exec(rest)?.[1];
    if (scheduleId !== undefined && method === 'DELETE') {
      const list = perApp(schedules, appId, () => [] as Json[]);
      const at = list.findIndex((each) => each['id'] === scheduleId);
      if (at < 0) return notFound();
      list.splice(at, 1);
      return json(200, { deleted: scheduleId });
    }
    const scheduling = /^\/flags\/([^/]+)\/schedules$/.exec(rest);
    if (scheduling !== undefined && scheduling !== null && method === 'POST') {
      const found = items.get(scheduling[1] as string);
      if (!found) return notFound();
      if (headers['if-match'] !== `"${String(found['revision'])}"`) return json(428, { message: 'Name the revision, in If-Match.' });
      const made = { id: id('schedule'), flag: scheduling[1], at: input['at'], patch: input['patch'], state: 'pending' };
      perApp(schedules, appId, () => [] as Json[]).push(made);
      return json(201, made);
    }
    const previewing = /^\/flags\/([^/]+)\/deletion-preview$/.exec(rest);
    if (previewing !== null && previewing !== undefined) {
      const found = items.get(previewing[1] as string);
      if (!found) return notFound();
      return json(200, { dryRun: true, target: { key: found['key'], state: found['state'] }, affects: { schedules: perApp(schedules, appId, () => [] as Json[]).filter((each) => each['flag'] === found['key']).length }, sideEffects: ['App code that reads this flag gets its default.'] });
    }
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

  function pasteStripeKey(input: Json, appId: string): Response {
    if (input['secretKey'] === 'sk_test_refused') return json(400, { statusCode: 400, message: 'Stripe refused the key: it is not valid.' });
    pastedKeys.push(String(input['secretKey']));
    const made = { connector: input['connector'], status: 'active', account: 'acct_test', publicKey: input['publishableKey'] ?? null };
    connections.set(appId, made);
    return json(200, made);
  }

  /**
   * The app's own server's key routes, acting on its app. The operator routes for the same things end here too:
   * `invitedBy` is the person, for those.
   */
  function asApp(method: string, path: string, headers: Record<string, string>, input: Json, appId: string, invitedBy: string | null = null, stale = false): Response {
    if (path === '/v2/billing/connection' && method === 'POST') return pasteStripeKey(input, appId);
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
    if (path.startsWith('/v2/accounts/invites')) {
      const workspace = headers['bridge-workspace'] as string;
      if (!listOf(workspaces).some((each) => each['id'] === workspace)) return notFound();
      return inviteRoutes(method, path, input, `${appId}/${workspace}`, invitedBy, stale) as Response;
    }
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
    /** Every request that made an app key: `POST /v2/identity-access/apps/{appId}/keys`. */
    keyMints: () => requests.filter((r) => r.method === 'POST' && /^\/v2\/identity-access\/apps\/[^/]+\/keys$/.test(r.path)),
    apps,
    sessions,
    holders,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** The issuer publishes its sign-in page, and its sign-in requests, in its metadata. */
    /** Offers sign-in with a short code (the app's `tools.shortCode`). */
    setDeviceCodes(on: boolean) {
      deviceCodes = on;
    },
    /** What the other device does on each poll, such as approving the code. */
    onDevicePoll(hook: ((userCode: string, polls: number) => void) | null) {
      onDevicePoll = hook;
      devicePolls = 0;
    },
    /** The person approves the code on the dashboard, deleting off unless ticked. */
    approveDevice(userCode: string, email: string, options: { workspace?: string; allowDelete?: boolean } = {}) {
      const person = people.get(email) as Person;
      Object.assign(grantOf(userCode), { status: 'approved', session: { person, workspace: options.workspace ?? person.workspaces[0]?.id ?? null, authTime: clock, canDelete: options.allowDelete === true } });
    },
    denyDevice(userCode: string) {
      grantOf(userCode).status = 'denied';
    },
    /** The next polls are answered slow_down. */
    slowDownDevice(userCode: string, times = 1) {
      grantOf(userCode).slowDown = times;
    },
    setSignInPage(url: string | null) {
      signInPage = url;
    },
    /** The server's protected resource metadata names this issuer instead of the Bridge App's. */
    setProtectedResourceIssuer(issuer: string | null) {
      protectedResourceIssuer = issuer;
    },
    /** Every sign-in request Bridge holds, by id. */
    signInRequests,
    /** Every token the fake gave, to check none leaks. */
    tokens: () => [...accessTokens.keys(), ...refreshTokens.keys()],
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
    /** What Identity and Access answers for the production switch: the password rules pass or not, and how many users must choose a new password. */
    setProduction(appId: string, status: { passes: boolean; users: number }) {
      production.set(appId, status);
    },
    /** How many passkeys the app's users made on its main address's domain. */
    setPasskeys(appId: string, count: number) {
      passkeys.set(appId, count);
    },
    /** Sets an app's list and "Your app" settings out of band. */
    setYourApp(appId: string, fields: { mode: 'development' | 'production'; main: string | null; addresses: { url: string; uses: string[] }[] }) {
      const app = apps.get(appId) as Json;
      app['addresses'] = fields.addresses;
      Object.assign(yourAppOf(app), { mode: fields.mode, main: fields.main });
    },
    /** An app key made out of band, as an operator would for CI: no request is made, so `keyMints` stays as it was. */
    addKey(appId: string, privileges: string[]): string {
      const made = { id: id('key'), app: appId, name: 'ci', privileges, secret: secret(), revoked: false };
      keys.set(made.id, made);
      return `bk.${appId}.${made.id}.${made.secret}`;
    },
    addWorkspace(appId: string, workspace: Json, people: Json[] = []) {
      perApp(workspaces, appId, () => [] as Json[]).push(workspace);
      perApp(members, `${appId}/${String(workspace['id'])}`, () => [] as Json[]).push(...people);
    },
    roles: (appId: string) => perApp(roles, appId, () => [] as Json[]),
    /** One event of the app's log, as Events and logs lists them. */
    addEvent(appId: string, event: { type: string; workspaceId?: string | null; userId?: string | null; data?: Json }) {
      perApp(eventLogs, appId, () => [] as Json[]).unshift({ id: id('event'), time: new Date(clock).toISOString(), workspaceId: null, userId: null, data: {}, ...event });
    },
    /** A person of the app, as Accounts' users route finds them by email. */
    addUser(appId: string, user: { id: string; email: string }) {
      perApp(appUsers, appId, () => [] as Json[]).push({ ...user, suspended: false, workspaces: [{ id: 'cust-1', status: 'active' }] });
    },
    members: (appId: string, workspace: string) => perApp(members, `${appId}/${workspace}`, () => [] as Json[]),
    /** A User's passkeys, as Identity and Access lists them for the app's admins (TBP-861). */
    userPasskeys: (appId: string, userId: string) => perApp(userPasskeyLists, `${appId}/${userId}`, () => [] as Json[]),
    /** A User's connected tools, as Identity and Access lists them for the app's admins (TBP-854). */
    userConnections: (appId: string, userId: string) => perApp(userConnectionLists, `${appId}/${userId}`, () => [] as Json[]),
    /** How many browser sessions a User has, ended by "sign out everywhere". */
    setBrowserSessions(appId: string, userId: string, count: number) {
      browserSessions.set(`${appId}/${userId}`, count);
    },
    browserSessions: (appId: string, userId: string) => browserSessions.get(`${appId}/${userId}`) ?? 0,
    /** Answers as a server from before Assistants and CLI. */
    beOlderServer() {
      olderServer = true;
    },
    /** The credentials saved for a provider, as the CLI sent them. */
    savedProvider: (appId: string, provider: string) => savedSecrets.get(`${appId}/${provider}`),
    /** Production holds the app's password rules at Recommended (TBP-872). */
    holdAtRecommended(appId: string) {
      perApp(production, appId, () => ({ passes: true, users: 0 }) as Json)['floor'] = 'recommended';
    },
    workspaces: (appId: string) => perApp(workspaces, appId, () => [] as Json[]),
    branding: (appId: string) => perApp(brandings, appId, () => ({ scheme: 'auto', colors: {}, radius: 'medium', font: 'system', revision: 1 }) as Json),
    /** Every invite of a workspace, any state: `bridge/<workspace>` for the developer's own, `<app>/<workspace>` for an app's. */
    invites: (where: string) => perApp(invites, where, () => [] as Json[]),
    /** Bridge refuses to send invites: the app has no email-links address, or the workspace sent too many. */
    refuseInvites(why: 'no-email-links' | 'too-many' | null) {
      inviteRefusal = why;
    },
    plans: (appId: string) => perApp(plans, appId, () => new Map<string, Json>()),
    flags: (appId: string) => perApp(flags, appId, () => new Map<string, Json>()),
    /** What Bridge's sign-in page does with a sign-in request: signs in on it, never trades the code, and answers where the code goes. */
    async signInOn(request: string, person: { email: string; password: string; workspace?: string }): Promise<{ code: string; redirectUri: string; state: string }> {
      const answer = signIn({ email: person.email, password: person.password, request, ...(person.workspace ? { workspace: person.workspace } : {}) });
      const body = (await answer.json()) as { code?: string; redirect_uri?: string; state?: string };
      if (!body.code || !body.redirect_uri || !body.state) throw new Error(`The fake sign-in page could not sign in: ${JSON.stringify(body)}`);
      return { code: body.code, redirectUri: body.redirect_uri, state: body.state };
    },
  };
}

export type FakeBridge = ReturnType<typeof createFakeBridge>;
export { V2 };
