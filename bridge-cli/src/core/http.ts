import { CliError, SIGN_IN_AGAIN, type CliErrorKind } from './errors.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

const TIMEOUT_MS = 30_000;

/**
 * One call to Bridge: JSON in, JSON out. A redirect is never followed, so a
 * token is never sent anywhere but the address the issuer listed. Anything
 * but a 2xx becomes a {@link CliError}.
 */
export async function call<T = unknown>(fetchFn: Fetch, request: HttpRequest): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  let body: string | undefined;
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError('network', `Could not reach ${new URL(request.url).host}: ${reason}`);
  }
  const parsed = await readBody(response);
  if (response.status >= 300 && response.status < 400) {
    throw new CliError('misconfigured', `Bridge answered ${request.method} ${pathOf(request.url)} with a redirect, which the CLI never follows.`, {
      status: response.status,
    });
  }
  if (!response.ok) throw errorFrom(response.status, parsed, response.headers);
  return { status: response.status, headers: response.headers, body: parsed as T };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The kinds of Bridge's RFC 9457 problems (`urn:bridge:problem:<kind>`), as CLI errors. */
const PROBLEM_KINDS: Readonly<Record<string, CliErrorKind>> = {
  'identity-recheck': 'reauthenticate',
  'privilege-missing': 'forbidden',
  'entitlement-missing': 'plan-required',
  'credential-missing': 'not-signed-in',
  'credential-refused': 'session-ended',
  'rate-limited': 'rate-limited',
  unavailable: 'unavailable',
  conflict: 'conflict',
};

/** OAuth and sign-in errors (`{ error: "…" }`), as CLI errors. */
const OAUTH_KINDS: Readonly<Record<string, CliErrorKind>> = {
  wrong_credentials: 'wrong-credentials',
  invalid_grant: 'session-ended',
  flow_expired: 'flow-expired',
  invalid_link: 'invalid',
  wrong_device: 'invalid',
  invalid_request: 'invalid',
  invalid_client: 'misconfigured',
  unsupported_grant_type: 'misconfigured',
  access_denied: 'forbidden',
  not_found: 'not-found',
  conflict: 'conflict',
  temporarily_unavailable: 'unavailable',
};

function kindOfStatus(status: number): CliErrorKind {
  if (status === 401) return 'not-signed-in';
  if (status === 402) return 'plan-required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409 || status === 412 || status === 428) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  return 'invalid';
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value) && value.every((each) => typeof each === 'string')) return value.join(' ');
  return undefined;
}

/** What Bridge said, read from any of the shapes its answers take, as one error. */
export function errorFrom(status: number, body: unknown, headers?: Headers): CliError {
  const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let kind = kindOfStatus(status);
  let message: string | undefined;

  const type = typeof fields['type'] === 'string' ? (fields['type'] as string) : '';
  if (type.startsWith('urn:bridge:problem:')) {
    kind = PROBLEM_KINDS[type.slice('urn:bridge:problem:'.length)] ?? kind;
    message = text(fields['detail']) ?? text(fields['title']);
  } else if (typeof fields['error'] === 'string' && OAUTH_KINDS[fields['error'] as string] !== undefined) {
    kind = OAUTH_KINDS[fields['error'] as string] as CliErrorKind;
    message = text(fields['error_description']) ?? (fields['error'] as string).replace(/_/g, ' ');
  } else {
    message = text(fields['message']) ?? text(fields['detail']) ?? text(fields['title']) ?? text(body);
  }

  const hint = hintFor(kind, fields, headers);
  return new CliError(kind, message ?? `Bridge answered ${String(status)}.`, { status, hint, details: body ?? undefined });
}

function hintFor(kind: CliErrorKind, fields: Record<string, unknown>, headers?: Headers): string | undefined {
  switch (kind) {
    case 'reauthenticate': {
      const maxAge = typeof fields['maxAge'] === 'number' ? ` within ${String(Math.round((fields['maxAge'] as number) / 60))} minutes of signing in` : '';
      return `This needs a recent sign-in. Sign in again with \`bridge auth login\`, then run it again${maxAge}.`;
    }
    case 'not-signed-in':
    case 'session-ended':
      return SIGN_IN_AGAIN;
    case 'rate-limited': {
      const after = headers?.get('retry-after');
      return after ? `Try again in ${after} seconds.` : 'Try again in a moment.';
    }
    case 'unavailable':
      return 'Bridge could not answer right now. Try again in a moment.';
    case 'forbidden':
      return typeof fields['privilege'] === 'string' ? `This needs the privilege ${fields['privilege'] as string}.` : undefined;
    default:
      return undefined;
  }
}
