import { HttpError } from '@nebulr-group/bridge-auth-core';
import { ConfigError } from './config.js';
import { ADMIN_SCOPE_PRIVILEGES } from './auth/scopes.js';

export function outputSuccess(data: unknown): void {
  const output = { success: true, data };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

/**
 * Emit a prompt body verbatim to stdout — used by `bridge guide …` commands
 * whose output is intended to be read by a human or pasted to an AI agent.
 * Wrapping the markdown in a JSON envelope makes it unreadable in a terminal
 * and forces scripts to parse JSON to recover the original text. Use the
 * `--json` flag on each guide command if the envelope is needed for tooling.
 */
export function outputPrompt(content: string): void {
  process.stdout.write(content.endsWith('\n') ? content : content + '\n');
}


/**
 * Turn "Privilege 'TOKEN_WRITE' required" into something the reader can act
 * on. Without this the message is a dead end: it names a privilege but not how
 * to obtain one, and the answer ("log in again, differently") is not guessable.
 */
export function privilegeHint(message: string): string | undefined {
  const match = /Privilege '([A-Z_]+)' required/.exec(message);
  const privilege = match?.[1];
  if (!privilege || !ADMIN_SCOPE_PRIVILEGES.has(privilege)) return undefined;
  return (
    `Your login token does not carry ${privilege}. ` +
    'Re-authenticate with `bridge auth login --admin` to request delete authority ' +
    'and the ability to create API tokens. The default login deliberately omits ' +
    'them — the token is stored on disk and lives for 10 days.'
  );
}

export function outputError(error: unknown): void {
  let code = 'UNKNOWN_ERROR';
  let message = 'An unknown error occurred';
  let details: unknown = undefined;
  let hint: string | undefined;
  let exitCode = 1;

  if (error instanceof ConfigError) {
    code = 'CONFIG_ERROR';
    message = error.message;
    exitCode = 3;
  } else if (error instanceof HttpError) {
    code = `HTTP_${error.status}`;
    message = error.message;
    details = error.body;
    exitCode = error.status >= 500 ? 2 : 1;

    // Extract nblocksCode if present
    if (typeof error.body === 'object' && error.body && 'nblocksCode' in error.body) {
      code = (error.body as Record<string, string>).nblocksCode;
    }

    if (error.status === 403) {
      // The server's message is the authoritative one; check the body too,
      // since the privilege name sometimes only appears there.
      const bodyMessage =
        typeof error.body === 'object' && error.body && 'message' in error.body
          ? String((error.body as Record<string, unknown>).message)
          : '';
      hint = privilegeHint(message) ?? privilegeHint(bodyMessage);
    }
  } else if (error instanceof Error) {
    message = error.message;
    // TBP-586: errors that carry their own machine-readable `code` (e.g.
    // ResolveError's FLAG_NOT_FOUND / TENANT_AMBIGUOUS / INVALID_OPTIONS)
    // report it instead of collapsing to UNKNOWN_ERROR.
    const carried = (error as { code?: unknown }).code;
    if (typeof carried === 'string' && carried.length > 0) {
      code = carried;
    }
  }

  const output = {
    success: false,
    error: {
      code,
      message,
      ...(hint !== undefined ? { hint } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  };
  process.stderr.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = exitCode;
}
