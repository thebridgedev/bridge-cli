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
  | 'misconfigured'
  | 'decision-needed';

export interface CliErrorOptions {
  readonly status?: number;
  readonly hint?: string;
  readonly details?: unknown;
  /** For `decision-needed`: what the developer has to decide. */
  readonly fields?: readonly DecisionField[];
}

export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;
  readonly fields: readonly DecisionField[] | undefined;

  constructor(kind: CliErrorKind, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.kind = kind;
    this.status = options.status;
    this.hint = options.hint;
    this.details = options.details;
    this.fields = options.fields;
  }
}

/** One decision a command will not make for the developer. */
export interface DecisionField {
  readonly name: string;
  readonly question: string;
  readonly type: 'string' | 'number' | 'boolean' | 'enum';
  readonly options?: readonly string[];
  /** The option that answers it on this command. */
  readonly flag?: string;
}

/**
 * Stops a command before it writes anything, because the developer has not made a product decision (a price, a trial,
 * the role an invitee gets): says each question and the option that answers it. Exit code 1, code `DECISION_NEEDED`.
 */
export function decisionNeeded(command: string, fields: readonly DecisionField[], context?: string, guide?: string): CliError {
  const names = fields.map((each) => each.name).join(', ');
  const flags = fields.map((each) => each.flag ?? each.name).join(' ');
  return new CliError(
    'decision-needed',
    `${command} needs ${fields.length === 1 ? 'a product decision' : `${String(fields.length)} product decisions`} the developer has not made: ${names}.${context === undefined ? '' : ` ${context}`} Nothing was changed.`,
    {
      hint:
        `Ask the developer each question in fields and wait for the answers; do not choose values for them. Then run ${command} again with ${flags}.` +
        (guide === undefined ? '' : ` \`bridge guide decision ${guide}\` says what each choice means.`),
      fields,
    },
  );
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
