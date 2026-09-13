/**
 * `bridge auth status` — prints whether a credentials file exists, who it's
 * for, and how long until it expires.
 *
 * Output is plain text (one key=value per line after the first), tuned for
 * humans. Other CLI commands emit structured JSON — auth status is the one
 * place where a developer is most likely to be eyeballing the result, so we
 * optimize for readability over machine-parseability.
 *
 * If the user wants JSON, they can run `cat ~/.config/bridge/credentials.json`.
 *
 * TBP-628 — the file can hold several apps, so this lists ALL of them and marks
 * the active one. Knowing which app is in force is the whole reason somebody
 * runs this command, and it was already the only place that told them.
 */
import type { Command } from 'commander';
import {
  credentialsPath,
  isExpired,
  listCredentials,
  readCredentialsFile,
  type CredentialEntry,
} from '../../credentials.js';
import { formatRelativeTime } from '../../auth/relative-time.js';

export function registerAuthStatusCommand(auth: Command): void {
  auth
    .command('status')
    .description('Show current authentication state (who, which app, expiry)')
    .action(() => {
      try {
        runStatus();
        process.exitCode = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bridge auth status: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

function runStatus(): void {
  const stdout = process.stdout;

  // Report on `BRIDGE_API_KEY` separately if set, so a CI user setting the env
  // var sees something useful.
  const envApiKey = process.env.BRIDGE_API_KEY?.trim();
  const envProfile = process.env.BRIDGE_PROFILE?.trim();

  let entries: CredentialEntry[];
  try {
    readCredentialsFile();
    entries = listCredentials();
  } catch (err) {
    stdout.write(
      `Credentials file at ${credentialsPath()} is unreadable: ${
        err instanceof Error ? err.message : String(err)
      }\n` + 'Run `bridge auth login` to refresh, or delete the file manually.\n',
    );
    return;
  }

  if (entries.length === 0) {
    if (envApiKey && envApiKey.length > 0) {
      stdout.write(
        'Using BRIDGE_API_KEY from environment (service-account / CI path).\n' +
          'Run `bridge auth login` to switch to interactive credentials.\n',
      );
      return;
    }
    stdout.write('Not logged in. Run `bridge auth login`.\n');
    return;
  }

  const active = entries.find((e) => e.isActive);
  if (active) {
    stdout.write(`Logged in as ${active.creds.user.email}\n`);
  } else {
    // A pointer at a credential that is gone. Say so rather than picking one:
    // an inferred default is exactly what this ticket is about.
    stdout.write(
      'No active credential selected — run `bridge auth use <profile>` to pick one.\n',
    );
  }

  for (const entry of entries) {
    writeEntry(entry, entries.length > 1);
  }

  stdout.write(`  credentials=${credentialsPath()}\n`);

  if (entries.length > 1) {
    stdout.write(
      '\nSwitch the default with `bridge auth use <label|app id>`, ' +
        'or target one command with `--profile <label|app id>`.\n',
    );
  }

  if (envProfile) {
    stdout.write(
      `\nBRIDGE_PROFILE=${envProfile} is set — it overrides the active credential above.\n`,
    );
  }

  if (envApiKey && envApiKey.length > 0) {
    // This used to claim the opposite. The credentials file has always won;
    // saying otherwise is how somebody comes to believe they retargeted the
    // CLI when they did not (TBP-628).
    stdout.write(
      '\nNote: BRIDGE_API_KEY is set in your environment but is IGNORED while a ' +
        'credentials file exists.\nTo use it, run `bridge auth logout --all`. ' +
        'To target another stored app, use `--profile`.\n',
    );
  }

  if (process.env.BRIDGE_APP_ID?.trim()) {
    stdout.write(
      '\nNote: BRIDGE_APP_ID has no effect. The app is carried by the credential ' +
        'itself; use `--profile <label|app id>` to target another one.\n',
    );
  }
}

function writeEntry(entry: CredentialEntry, showMarker: boolean): void {
  const stdout = process.stdout;
  const { creds } = entry;

  const expiryDelta = new Date(creds.expiresAt).getTime() - Date.now();
  const expiryRel = formatRelativeTime(expiryDelta);
  const expiredLabel = isExpired(creds) ? ' (EXPIRED)' : '';
  const marker = showMarker ? (entry.isActive ? '* ' : '  ') : '';

  stdout.write(`  ${marker}app=${creds.app.name} (${creds.app.id})\n`);
  if (creds.label) stdout.write(`  ${marker}  label=${creds.label}\n`);
  stdout.write(`  ${marker}  user=${creds.user.email}\n`);
  stdout.write(`  ${marker}  expires=${expiryRel} — ${creds.expiresAt}${expiredLabel}\n`);
  stdout.write(`  ${marker}  baseUrl=${creds.baseUrl}\n`);
}
