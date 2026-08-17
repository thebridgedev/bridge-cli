import type { ToolResult } from '../types.js';

/**
 * Duck-typed view of auth-core's HttpError. We deliberately do NOT
 * `instanceof HttpError` against our own copy of auth-core: the transport
 * shell (bridge-cli) constructs the management client from *its* copy of
 * `@nebulr-group/bridge-auth-core`, so an instanceof check across package
 * boundaries would silently fail. Shape-checking `status` is robust to that.
 */
interface HttpErrorLike extends Error {
  status: number;
  body?: unknown;
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return (
    err instanceof Error &&
    typeof (err as Partial<HttpErrorLike>).status === 'number'
  );
}

/**
 * Map a thrown error from a management-client call to the failure envelope.
 * Mirrors the Bridge CLI's `outputError` mapping: HTTP errors become
 * `HTTP_<status>` (or the server's `nblocksCode` when present) and carry an
 * agent-actionable `fix` hint for the common auth failures.
 */
export function toErrorResult(err: unknown): ToolResult {
  if (isHttpErrorLike(err)) {
    let code = `HTTP_${err.status}`;
    if (typeof err.body === 'object' && err.body && 'nblocksCode' in err.body) {
      code = String((err.body as Record<string, unknown>).nblocksCode);
    }
    let fix: string | undefined;
    if (err.status === 401) {
      fix =
        'The API key is invalid or expired. Re-authenticate with `bridge auth login`, ' +
        'or set a valid BRIDGE_API_KEY environment variable.';
    } else if (err.status === 403) {
      fix =
        'The API key lacks the privilege for this read. Use a key with broader ' +
        'privileges (see `bridge token list`) or re-run `bridge auth login`.';
    }
    return {
      success: false,
      error: { code, message: err.message, ...(fix ? { fix } : {}) },
    };
  }
  return {
    success: false,
    error: {
      code: 'UNEXPECTED_ERROR',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}
