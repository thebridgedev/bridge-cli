/**
 * `bridge auth logout` — best-effort revoke + delete credentials file.
 *
 * Behavior:
 *   - No credentials file → "Not logged in." (exit 0).
 *   - File present       → call `POST /v1/auth/cli/revoke` with `x-api-key`,
 *                          treat 401 as success (token already gone), then
 *                          delete the file. Network errors → warn but still
 *                          delete (the local file is the source of truth for
 *                          "logged in" on this machine).
 */
import type { Command } from 'commander';
import { credentialsPath, deleteCredentials, readCredentials } from '../../credentials.js';
import { resetManagementClient } from '../../config.js';
import { createCliApiClient, CliAuthApiError } from '../../auth/api-client.js';

export function registerAuthLogoutCommand(auth: Command): void {
  auth
    .command('logout')
    .description('Revoke the saved CLI token and delete local credentials')
    .action(async () => {
      try {
        await runLogout();
        process.exitCode = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bridge auth logout: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

async function runLogout(): Promise<void> {
  const stdout = process.stdout;
  const stderr = process.stderr;

  let creds;
  try {
    creds = readCredentials();
  } catch (err) {
    // Malformed credentials file — still try to delete it so the user gets unstuck.
    stderr.write(
      `Warning: existing credentials file at ${credentialsPath()} could not be parsed (${
        err instanceof Error ? err.message : String(err)
      }). Removing it.\n`,
    );
    deleteCredentials();
    stdout.write('Logged out (credentials file removed).\n');
    return;
  }

  if (!creds) {
    stdout.write('Not logged in.\n');
    return;
  }

  const api = createCliApiClient({ baseUrl: creds.baseUrl });
  try {
    await api.revokeToken(creds.apiKey);
  } catch (err) {
    // Network failure — warn but still proceed with local deletion.
    if (err instanceof CliAuthApiError && err.code === 'network_error') {
      stderr.write(`Warning: could not reach bridge-api to revoke server-side (${err.message}). Removing local credentials anyway.\n`);
    } else {
      // Any other API error is also non-fatal for the local cleanup, but we
      // surface it so the user knows the server-side revoke didn't happen.
      stderr.write(
        `Warning: server-side revoke returned an error (${
          err instanceof Error ? err.message : String(err)
        }). Removing local credentials anyway.\n`,
      );
    }
  }

  deleteCredentials();
  resetManagementClient();
  stdout.write(`Logged out ${creds.user.email}.\n`);
}
