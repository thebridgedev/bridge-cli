/**
 * The one error type every command reports. `kind` says what went wrong in
 * words a script can branch on; `hint` says what to do next.
 */
export type CliErrorKind =
  | 'not-signed-in'
  | 'session-ended'
  | 'reauthenticate'
  | 'wrong-credentials'
  | 'flow-expired'
  | 'unsupported-step'
  | 'cancelled'
  | 'forbidden'
  | 'plan-required'
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'rate-limited'
  | 'unavailable'
  | 'network'
  | 'not-offered'
  | 'misconfigured';

export interface CliErrorOptions {
  readonly status?: number;
  readonly hint?: string;
  readonly details?: unknown;
}

export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(kind: CliErrorKind, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.kind = kind;
    this.status = options.status;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

/**
 * Exit codes: 1 for a refused or failed command, 2 when Bridge could not be
 * reached or could not answer, 3 when the CLI is not set up (no issuer, not
 * signed in, a setting that is wrong).
 */
export function exitCodeOf(error: unknown): number {
  if (!isCliError(error)) return 1;
  if (error.kind === 'unavailable' || error.kind === 'network') return 2;
  if (error.kind === 'misconfigured' || error.kind === 'not-signed-in' || error.kind === 'session-ended') return 3;
  return 1;
}

export const SIGN_IN_AGAIN = 'Sign in again with `bridge auth login` (or `bridge auth login --password`).';
