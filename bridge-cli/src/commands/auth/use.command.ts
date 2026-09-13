/**
 * `bridge auth use <profile>` — move the persisted default to another stored
 * credential, without a browser round-trip (TBP-628).
 *
 * The credential is already on disk with days left on it; switching is a
 * pointer move. Before this existed the only way to change apps was
 * `auth logout` + `auth login`, which discarded a perfectly valid token and
 * cost a browser trip, so people did not switch — they ran commands against
 * whichever app happened to be active and read the answers as if they came
 * from the one they meant.
 *
 * For a single command, prefer `--profile` / `BRIDGE_PROFILE`: this command
 * mutates state that other processes read.
 */
import type { Command } from 'commander';
import {
  CredentialSelectorError,
  findCredential,
  isExpired,
  listCredentials,
  setActiveCredential,
} from '../../credentials.js';
import { resetManagementClient } from '../../config.js';

export function registerAuthUseCommand(auth: Command): void {
  auth
    .command('use <profile>')
    .description('Switch the default app to another stored credential (no re-login)')
    .action((profile: string) => {
      try {
        runUse(profile);
        process.exitCode = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bridge auth use: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

function runUse(profile: string): void {
  const stdout = process.stdout;

  let entry;
  try {
    entry = findCredential(profile);
  } catch (err) {
    if (err instanceof CredentialSelectorError) throw new Error(err.message);
    throw err;
  }

  setActiveCredential(entry.key);
  resetManagementClient();

  const name = entry.creds.label ?? entry.creds.app.name;
  stdout.write(`Now using ${name} — ${entry.creds.app.name} (${entry.creds.app.id})\n`);
  stdout.write(`  baseUrl=${entry.creds.baseUrl}\n`);

  // Switching TO an expired credential is allowed — it is the user's stated
  // intent, and refusing would leave them unable to make it the default before
  // re-authenticating it. But it must not be a surprise at the next command.
  if (isExpired(entry.creds)) {
    stdout.write(
      `  WARNING: this credential expired ${entry.creds.expiresAt}. ` +
        'Run `bridge auth login` to refresh it.\n',
    );
  }

  const others = listCredentials().filter((e) => e.key !== entry.key);
  if (others.length > 0) {
    stdout.write(
      `  also stored: ${others.map((e) => e.creds.label ?? e.creds.app.name).join(', ')}\n`,
    );
  }
}
