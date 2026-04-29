/**
 * Thin client for the bridge-api `/v1/auth/cli/*` endpoints.
 *
 * - `exchangeCode(...)` calls `POST /v1/auth/cli/token` with `{code, code_verifier}`.
 * - `revokeToken(...)` calls `POST /v1/auth/cli/revoke` with `x-api-key: <jwt>`.
 *
 * Errors come back RFC-style as `{ error, error_description }`. We translate
 * the common cases to friendly messages so end-users don't see RFC tags.
 *
 * The CLI authenticates as `x-api-key: <jwt>` (NOT `Authorization: Bearer`) —
 * see TBP-111 contract notes.
 */

export interface CliTokenExchangeResponse {
  api_token: string;
  expires_at: string;
  app: { id: string; name: string };
  user: { id: string; email: string };
}

export interface CliApiClientOptions {
  /** Base URL of bridge-api, e.g. `https://api.thebridge.dev`. No trailing slash. */
  baseUrl: string;
  /** Used for diagnostics; do NOT log secrets. */
  debug?: boolean;
  /** Override fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class CliAuthApiError extends Error {
  /** RFC error code returned by bridge-api (`invalid_request`, `invalid_grant`, ...). */
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CliAuthApiError';
    this.code = code;
    this.status = status;
  }
}

export function createCliApiClient(options: CliApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No global `fetch` is available. Run bridge-cli on Node.js >= 18.',
    );
  }

  async function exchangeCode(args: {
    code: string;
    codeVerifier: string;
  }): Promise<CliTokenExchangeResponse> {
    const url = `${baseUrl}/v1/auth/cli/token`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: args.code,
        code_verifier: args.codeVerifier,
      }),
    });

    if (!res.ok) {
      throw await translateError(res);
    }

    const body = (await res.json()) as CliTokenExchangeResponse;
    if (!body || typeof body.api_token !== 'string') {
      throw new CliAuthApiError(
        'invalid_response',
        'Bridge API returned an unexpected response from /v1/auth/cli/token.',
        res.status,
      );
    }
    return body;
  }

  /**
   * Best-effort revoke. The CLI uses self-revoke (token is identified by the
   * `x-api-key` it sends). 401 means the token is already gone — treat as
   * success.
   */
  async function revokeToken(token: string): Promise<{ revoked: boolean }> {
    const url = `${baseUrl}/v1/auth/cli/revoke`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
        },
        body: '{}',
      });
    } catch (err) {
      // Network failure — caller can still delete the local file.
      throw new CliAuthApiError(
        'network_error',
        `Could not reach bridge-api to revoke token: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    if (res.ok) return { revoked: true };
    if (res.status === 401) return { revoked: true }; // already revoked / expired
    throw await translateError(res);
  }

  return { exchangeCode, revokeToken };
}

async function translateError(res: Response): Promise<CliAuthApiError> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return new CliAuthApiError(
      'http_error',
      `Bridge API returned HTTP ${res.status}.`,
      res.status,
    );
  }

  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const code = typeof obj.error === 'string' ? obj.error : 'http_error';
  const desc = typeof obj.error_description === 'string' ? obj.error_description : undefined;

  let friendly: string;
  switch (code) {
    case 'invalid_request':
      friendly = desc ?? 'The login request was rejected as malformed.';
      break;
    case 'invalid_grant':
      friendly = 'The authorization code has already been used or is invalid. Please run `bridge auth login` again.';
      break;
    case 'expired_grant':
      friendly = 'The authorization code expired before it could be exchanged. Please run `bridge auth login` again.';
      break;
    case 'access_denied':
      friendly = 'Login cancelled.';
      break;
    default:
      friendly = desc ?? `Bridge API returned HTTP ${res.status}.`;
  }
  return new CliAuthApiError(code, friendly, res.status);
}
