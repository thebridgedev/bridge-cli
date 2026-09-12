/**
 * `bridge auth logout` — best-effort revoke + delete credentials file.
 *
 * Behavior:
 *   - No credentials file → "Not logged in." (exit 0).
 *   - Otherwise          → call `POST /v1/auth/cli/revoke` with `x-api-key`,
 *                          treat 401 as success (token already gone), then
 *                          remove it locally. Network errors → warn but still
 *                          remove (the local file is the source of truth for
 *                          "logged in" on this machine).
 *
 * TBP-628 — the file can hold several apps, so logout now has a scope.
 * Bare `logout` removes the ACTIVE credential and leaves the others; the
 * alternative, wiping every app because you finished with one of them, throws
 * away valid tokens and forces browser round-trips to get them back, which is
 * the friction this ticket exists to remove. `--profile` names one, `--all`
 * asks for the old whole-file behaviour explicitly.
 */
import type { Command } from 'commander';
import {
  credentialsPath,
  CredentialSelectorError,
  deleteAllCredentials,
  findCredential,
  listCredentials,
  readCredentials,
  removeCredential,
  type StoredCredentials,
} from '../../credentials.js';
import { resetManagementClient } from '../../config.js';
import { createCliApiClient, CliAuthApiError } from '../../auth/api-client.js';

export function registerAuthLogoutCommand(auth: Command): void {
  auth
    .command('logout')
    .description('Revoke the active CLI token and remove it locally')
    .option('--profile <label|app-id|app-name>', 'Log out of one specific stored app')
    .option('--all', 'Log out of every stored app and delete the credentials file')
    .action(async (opts: { profile?: string; all?: boolean }) => {
      try {
        await runLogout(opts);
        process.exitCode = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bridge auth logout: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

async function runLogout(opts: { profile?: string; all?: boolean } = {}): Promise<void> {
  const stdout = process.stdout;
  const stderr = process.stderr;

  let entries;
  try {
    entries = listCredentials();
  } catch (err) {
    // Malformed credentials file — still delete it so the user gets unstuck.
    stderr.write(
      `Warning: existing credentials file at ${credentialsPath()} could not be parsed (${
        err instanceof Error ? err.message : String(err)
      }). Removing it.\n`,
    );
    deleteAllCredentials();
    stdout.write('Logged out (credentials file removed).\n');
    return;
  }

  if (entries.length === 0) {
    stdout.write('Not logged in.\n');
    return;
  }

  if (opts.all) {
    for (const entry of entries) await revoke(entry.creds, stderr);
    deleteAllCredentials();
    resetManagementClient();
    stdout.write(`Logged out of ${entries.length} app(s).\n`);
    return;
  }

  let target;
  if (opts.profile) {
    try {
      target = findCredential(opts.profile);
    } catch (err) {
      if (err instanceof CredentialSelectorError) throw new Error(err.message);
      throw err;
    }
  } else {
    const active = readCredentials();
    if (!active) {
      // Several stored, none active. Removing one by guess is exactly the
      // silent choice this ticket forbids.
      throw new Error(
        'No active credential. Name one with `--profile <label|app id>`, or use `--all`. ' +
          `Stored: ${entries.map((e) => e.creds.label ?? e.creds.app.name).join(', ')}.`,
      );
    }
    target = entries.find((e) => e.key === active.app.id)!;
  }

  await revoke(target.creds, stderr);
  const remaining = removeCredential(target.key);
  resetManagementClient();

  const name = target.creds.label ?? target.creds.app.name;
  stdout.write(`Logged out ${target.creds.user.email} from ${name}.\n`);
  if (remaining > 0) {
    const rest = listCredentials();
    const nowActive = rest.find((e) => e.isActive);
    stdout.write(
      `  ${remaining} credential(s) still stored` +
        (nowActive ? `; now using ${nowActive.creds.label ?? nowActive.creds.app.name}` : '') +
        '.\n',
    );
  }
}

/** Best-effort server-side revoke. Never fatal — local removal is the point. */
async function revoke(creds: StoredCredentials, stderr: NodeJS.WriteStream): Promise<void> {
  const api = createCliApiClient({ baseUrl: creds.baseUrl });
  try {
    await api.revokeToken(creds.apiKey);
  } catch (err) {
    if (err instanceof CliAuthApiError && err.code === 'network_error') {
      stderr.write(
        `Warning: could not reach bridge-api to revoke ${creds.app.name} server-side (${err.message}). Removing local credentials anyway.\n`,
      );
    } else {
      stderr.write(
        `Warning: server-side revoke for ${creds.app.name} returned an error (${
          err instanceof Error ? err.message : String(err)
        }). Removing local credentials anyway.\n`,
      );
    }
  }
}
