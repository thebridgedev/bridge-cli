import { HttpError } from '@nebulr-group/bridge-auth-core';
import { ConfigError } from './config.js';

export function outputSuccess(data: unknown): void {
  const output = { success: true, data };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
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
