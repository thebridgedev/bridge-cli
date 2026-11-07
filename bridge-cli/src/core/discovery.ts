import { CliError } from './errors.js';
import { call, type Fetch } from './http.js';
import { API_VERSION, type Service } from './routes.js';
import { secureUrl } from './urls.js';

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
  /** Bridge's own sign-in page for programs on this machine, when the issuer lists one. */
  readonly signInPage: string | null;
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

  return {
    issuer,
    appId,
    signIn: endpoint('sign_in'),
    token: endpoint('token'),
    revoke: endpoint('revoke'),
    signOut,
    signInPage: listed(v2?.['sign_in_page'], 'sign_in_page') ?? listed(meta['authorization_endpoint'], 'authorization_endpoint'),
    bases: {
      'app-registry': required(appRegistry, 'app_registry'),
      'identity-access': required(identityAccess, 'identity_access'),
      billing: required(billing, 'billing'),
      flags: required(flags, 'flags'),
      accounts: required(accounts, 'accounts'),
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
