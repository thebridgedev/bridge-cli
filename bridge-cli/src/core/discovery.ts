import { CliError } from './errors.js';
import { call, type Fetch } from './http.js';
import { API_VERSION, type Service } from './routes.js';
import { normalizeIssuer, secureUrl } from './urls.js';

/**
 * Discovery: the issuer is the only address the CLI is given. Everything else
 * comes from the issuer's metadata at `<issuer>/.well-known/openid-configuration`
 * (RFC 8414), which lists each version's endpoints under `bridge_endpoints`.
 * The CLI reads version 2 only, so a newer version never changes what it calls.
 */
export interface Discovery {
  readonly issuer: string;
  /** The app the issuer signs in to: the Bridge App, for the developer. */
  readonly appId: string;
  readonly signIn: string;
  readonly token: string;
  readonly revoke: string;
  readonly signOut: string | null;
  /**
   * Bridge's own sign-in page, and where a sign-in request for it starts, when the issuer lists them: the browser
   * sign-in starts a request there with the CLI's loopback return, then opens the page with `?request=<id>`.
   */
  readonly signInPage: string | null;
  readonly signInRequests: string | null;
  /**
   * Sign-in with a short code (RFC 8628), when the app offers it: where the CLI asks for a code. Listed under
   * `bridge_endpoints["2"].device_authorization`, or as the standard `device_authorization_endpoint`; null when off.
   */
  readonly deviceAuthorization: string | null;
  /** Each microservice's base address at version 2. */
  readonly bases: Readonly<Record<Service, string>>;
}

/** The standard fields an issuer at version 2 may list instead of `bridge_endpoints["2"]`. */
const STANDARD_FIELDS = {
  sign_in: 'authorization_challenge_endpoint',
  token: 'token_endpoint',
  revoke: 'revocation_endpoint',
} as const;

function misconfigured(message: string): CliError {
  return new CliError('misconfigured', message, {
    hint: 'Check the issuer: it is the Bridge App\'s issuer, as Bridge publishes it.',
  });
}

function listed(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const url = secureUrl(value);
  if (url === null) throw misconfigured(`The issuer's metadata lists "${name}" at an address that is not https: ${String(value)}`);
  return url.toString().replace(/\/+$/, '');
}

function required(value: string | null, name: string): string {
  if (value === null) throw misconfigured(`The issuer's metadata lists no "${name}" endpoint.`);
  return value;
}

/** The address of a microservice's base, from a listed address under it: `<base>/<service>/…` gives `<base>/<service>`. */
function baseFrom(address: string | null, suffix: string): string | null {
  if (address === null || !address.endsWith(suffix)) return null;
  return address.slice(0, -suffix.length);
}

/**
 * The sign-in page and its sign-in requests, both or neither. The page keeps its trailing slash: it is a page, not an
 * API base, and the CLI adds only `?request=<id>` to it.
 */
function pageAndRequests(v2: Record<string, unknown> | null): { signInPage: string | null; signInRequests: string | null } {
  const requests = listed(v2?.['sign_in_requests'], 'sign_in_requests');
  const pageValue = v2?.['sign_in_page'];
  if (requests === null || pageValue === undefined || pageValue === null) return { signInPage: null, signInRequests: null };
  const page = secureUrl(pageValue);
  if (page === null) throw misconfigured(`The issuer's metadata lists "sign_in_page" at an address that is not https: ${String(pageValue)}`);
  if (page.search !== '' || page.hash !== '') throw misconfigured(`The issuer's metadata lists "sign_in_page" with a query or fragment: ${String(pageValue)}`);
  return { signInPage: page.toString(), signInRequests: requests };
}

export function metadataUrl(issuer: string): string {
  return `${issuer}/.well-known/openid-configuration`;
}

/** Reads the metadata document into the endpoints the CLI calls. Exposed for tests. */
export function readMetadata(issuer: string, document: unknown): Discovery {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw misconfigured('The issuer\'s metadata is not a JSON object.');
  }
  const meta = document as Record<string, unknown>;
  if (meta['issuer'] !== issuer) {
    throw misconfigured(`The metadata names another issuer (${String(meta['issuer'])}) than the one asked for (${issuer}).`);
  }
  const appId = meta['bridge_app'];
  if (typeof appId !== 'string' || appId === '') throw misconfigured('The issuer\'s metadata does not name its app (bridge_app).');

  const all = meta['bridge_endpoints'];
  const byVersion = typeof all === 'object' && all !== null ? (all as Record<string, unknown>)[String(API_VERSION)] : undefined;
  const v2 = typeof byVersion === 'object' && byVersion !== null ? (byVersion as Record<string, unknown>) : null;
  // Without version 2's own list, the standard fields are read only from an issuer that says it is at version 2.
  if (v2 === null && meta['bridge_api_version'] !== API_VERSION) {
    throw misconfigured(`The issuer does not offer version ${String(API_VERSION)} of Bridge's API, which this CLI uses.`);
  }
  const endpoint = (name: keyof typeof STANDARD_FIELDS): string =>
    required(listed(v2?.[name], name) ?? (meta['bridge_api_version'] === API_VERSION ? listed(meta[STANDARD_FIELDS[name]], STANDARD_FIELDS[name]) : null), name);

  const accounts = listed(v2?.['accounts'], 'accounts');
  const billing = listed(v2?.['billing'], 'billing');
  const flags = listed(v2?.['flags'], 'flags');
  const sessions = listed(v2?.['sessions'], 'sessions');
  const signOut = listed(v2?.['sign_out'], 'sign_out');
  // Listed by name when the issuer lists them; else found next to the ones it lists.
  const identityAccess = listed(v2?.['identity_access'], 'identity_access') ?? baseFrom(sessions, '/sessions') ?? baseFrom(signOut, '/sign-out');
  const appRegistry = listed(v2?.['app_registry'], 'app_registry') ?? (baseFrom(accounts, '/accounts') === null ? null : `${baseFrom(accounts, '/accounts') as string}/app-registry`);
  // Listed by name when the issuer lists them; else beside Accounts, where Bridge keeps every microservice.
  const eventsAndLogs = listed(v2?.['events_and_logs'], 'events_and_logs') ?? (baseFrom(accounts, '/accounts') === null ? null : `${baseFrom(accounts, '/accounts') as string}/events-and-logs`);
  const communication = listed(v2?.['communication'], 'communication') ?? (baseFrom(accounts, '/accounts') === null ? null : `${baseFrom(accounts, '/accounts') as string}/communication`);

  return {
    issuer,
    appId,
    signIn: endpoint('sign_in'),
    token: endpoint('token'),
    revoke: endpoint('revoke'),
    signOut,
    // Listed together, for an app whose page signs in for programs (the Bridge App): a page without its requests is not offered.
    ...pageAndRequests(v2),
    deviceAuthorization: listed(v2?.['device_authorization'], 'device_authorization') ?? listed(meta['device_authorization_endpoint'], 'device_authorization_endpoint'),
    bases: {
      'app-registry': required(appRegistry, 'app_registry'),
      'identity-access': required(identityAccess, 'identity_access'),
      billing: required(billing, 'billing'),
      flags: required(flags, 'flags'),
      accounts: required(accounts, 'accounts'),
      'events-and-logs': required(eventsAndLogs, 'events_and_logs'),
      communication: required(communication, 'communication'),
    },
  };
}

/** Fetches and reads the issuer's metadata. */
export async function discover(fetchFn: Fetch, issuer: string): Promise<Discovery> {
  let body: unknown;
  try {
    ({ body } = await call(fetchFn, { method: 'GET', url: metadataUrl(issuer) }));
  } catch (error) {
    if (error instanceof CliError && (error.kind === 'not-found' || error.kind === 'invalid')) {
      throw misconfigured(`No Bridge issuer answers at ${issuer}.`);
    }
    throw error;
  }
  return readMetadata(issuer, body);
}

/**
 * The Bridge App's issuer at a Bridge server: the authorization server its protected resource metadata names (RFC 9728,
 * at the server's `/.well-known/oauth-protected-resource`), on the server's own origin. So `--server` is the only
 * address a developer types; an issuer elsewhere is refused.
 */
export async function issuerAtServer(fetchFn: Fetch, server: string): Promise<string> {
  const url = secureUrl(server);
  if (url === null || url.search !== '' || url.hash !== '') {
    throw new CliError('misconfigured', `The server must be an https address (http only on localhost), with no query: ${server}`, {
      hint: 'Pass Bridge\'s address, for example `--server https://api.example.com`.',
    });
  }
  let body: unknown;
  try {
    ({ body } = await call(fetchFn, { method: 'GET', url: `${url.origin}/.well-known/oauth-protected-resource` }));
  } catch (error) {
    if (error instanceof CliError && (error.kind === 'not-found' || error.kind === 'invalid')) throw misconfigured(`No Bridge server answers at ${url.origin}.`);
    throw error;
  }
  const named = (body as { authorization_servers?: unknown } | null)?.authorization_servers;
  const first = Array.isArray(named) ? named[0] : undefined;
  const issuer = secureUrl(first);
  if (issuer === null) throw misconfigured(`${url.origin} names no sign-in issuer.`);
  if (issuer.origin !== url.origin) throw misconfigured(`${url.origin} names a sign-in issuer on another address (${issuer.origin}), which the CLI does not use.`);
  return normalizeIssuer(issuer.toString());
}
