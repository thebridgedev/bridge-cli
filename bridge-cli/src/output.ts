import { HttpError } from '@nebulr-group/bridge-auth-core';
import { ConfigError } from './config.js';

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

export function outputError(error: unknown): void {
  let code = 'UNKNOWN_ERROR';
  let message = 'An unknown error occurred';
  let details: unknown = undefined;
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
  } else if (error instanceof Error) {
    message = error.message;
  }

  const output = { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
  process.stderr.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = exitCode;
}
