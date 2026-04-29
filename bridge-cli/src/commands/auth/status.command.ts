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
 */
import type { Command } from 'commander';
import { credentialsPath, isExpired, readCredentials } from '../../credentials.js';
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

  // Prefer the credentials file; report on `BRIDGE_API_KEY` separately if set
  // (so a CI user setting the env var sees something useful).
  const envApiKey = process.env.BRIDGE_API_KEY?.trim();

  let creds;
  try {
    creds = readCredentials();
  } catch (err) {
    stdout.write(
      `Credentials file at ${credentialsPath()} is unreadable: ${
        err instanceof Error ? err.message : String(err)
      }\n` + 'Run `bridge auth login` to refresh, or delete the file manually.\n',
    );
    return;
  }

  if (!creds) {
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

  const expiryDate = new Date(creds.expiresAt);
  const expiryDelta = expiryDate.getTime() - Date.now();
  const expiryRel = formatRelativeTime(expiryDelta);
  const expiredLabel = isExpired(creds) ? ' (EXPIRED)' : '';

  stdout.write(`Logged in as ${creds.user.email}\n`);
  stdout.write(`  app=${creds.app.name} (${creds.app.id})\n`);
  stdout.write(`  expires=${expiryRel} — ${creds.expiresAt}${expiredLabel}\n`);
  stdout.write(`  baseUrl=${creds.baseUrl}\n`);
  if (creds.label) stdout.write(`  label=${creds.label}\n`);
  stdout.write(`  credentials=${credentialsPath()}\n`);

  if (envApiKey && envApiKey.length > 0) {
    stdout.write(
      '\nNote: BRIDGE_API_KEY is also set in your environment — it takes precedence over the credentials file.\n',
    );
  }

  if (isExpired(creds)) {
    process.exitCode = 0; // status is informational; don't fail just because expired.
  }
}
