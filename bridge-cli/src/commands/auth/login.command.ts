/**
 * `bridge auth login` — browser-based loopback PKCE flow.
 *
 * Drives:  PKCE pair → ephemeral loopback listener → open browser →
 *          await callback → exchange code → write credentials file.
 *
 * Default flow (per TBP-107 Q4): open the browser automatically, fall back
 * to printing the URL if the open command fails or `--no-browser` is set.
 *
 * Hostnames (locked in TBP-107):
 *   Consent screen: `https://auth.thebridge.dev/cli/authorize`
 *   API:            `https://api.thebridge.dev/v1/auth/cli/token`
 *
 * Both endpoints can be overridden for local dev:
 *   `BRIDGE_BASE_URL`         → bridge-api host
 *   `BRIDGE_AUTH_BASE_URL`    → consent screen host
 */
import type { Command } from 'commander';
import { writeCredentials, type StoredCredentials } from '../../credentials.js';
import { resetManagementClient } from '../../config.js';
import { generateCodeVerifier, codeChallengeFor, generateState } from '../../auth/pkce.js';
import { startLoopback, LoopbackError } from '../../auth/loopback.js';
import { openBrowser } from '../../auth/browser-open.js';
import { createCliApiClient, CliAuthApiError } from '../../auth/api-client.js';

const DEFAULT_API_BASE_URL = 'https://api.thebridge.dev';
const DEFAULT_AUTH_BASE_URL = 'https://auth.thebridge.dev';

interface LoginOptions {
  app?: string;
  label?: string;
  /**
   * commander's `--no-browser` flag sets `browser=false` (default `true`).
   * We read this as `opts.browser === false` → use --no-browser path.
   */
  browser?: boolean;
}

export function registerAuthLoginCommand(auth: Command): void {
  auth
    .command('login')
    .description('Authenticate via browser (loopback PKCE) and save credentials')
    .option('--app <id|name>', 'Pin to a specific app (skips the picker on the consent screen)')
    .option('--label <text>', 'Friendly label stored on the token (default: "bridge-cli")')
    .option('--no-browser', 'Print the authorization URL instead of opening a browser')
    .action(async (opts: LoginOptions) => {
      try {
        await runLogin(opts);
        process.exitCode = 0;
      } catch (err) {
        // Friendly, single-line stderr — never log JWTs / verifiers.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bridge auth login: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

async function runLogin(opts: LoginOptions): Promise<void> {
  const apiBaseUrl = (process.env.BRIDGE_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const authBaseUrl = (process.env.BRIDGE_AUTH_BASE_URL?.trim() || DEFAULT_AUTH_BASE_URL).replace(/\/$/, '');

  // 1. PKCE + state.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);
  const state = generateState();

  // 2. Boot the single-shot loopback listener.
  let loopback;
  try {
    loopback = await startLoopback({
      expectedState: state,
      // Bounce the browser to a branded success page on cloud-views instead
      // of leaving the user staring at 127.0.0.1.
      successRedirectUrl: `${authBaseUrl}/cli/login-complete`,
    });
  } catch (err) {
    throw new Error(
      `Could not bind a loopback port: ${err instanceof Error ? err.message : String(err)}. ` +
        'Try `bridge auth login --device` once TBP-108 lands, or check whether your firewall blocks 127.0.0.1.',
    );
  }

  const authorizeUrl = buildAuthorizeUrl(authBaseUrl, {
    challenge: codeChallenge,
    redirect: loopback.redirectUri,
    state,
    appId: opts.app,
    label: opts.label,
  });

  // 3. Open browser (or print URL if --no-browser or open fails).
  const stdout = process.stdout;
  // commander's `--no-browser` sets opts.browser === false. Treat unset as the
  // default (open browser); only skip when explicitly false.
  const useBrowser = opts.browser !== false;
  if (!useBrowser) {
    stdout.write(`Open this URL in your browser to continue:\n  ${authorizeUrl}\n`);
  } else {
    const open = await openBrowser(authorizeUrl);
    if (!open.ok) {
      stdout.write(
        `Could not open a browser automatically (${open.reason ?? 'unknown'}). ` +
          `Open this URL manually:\n  ${authorizeUrl}\n`,
      );
    } else {
      stdout.write('Opened your browser. Waiting for authorization...\n');
    }
  }

  // 4. Await the callback. Translate cancel/CSRF/timeout into friendly errors.
  let result;
  try {
    result = await loopback.result;
  } catch (err) {
    if (err instanceof LoopbackError) {
      throw new Error(err.message);
    }
    throw err;
  }

  // 5. Exchange the code for a JWT.
  const api = createCliApiClient({ baseUrl: apiBaseUrl });
  let exchanged;
  try {
    exchanged = await api.exchangeCode({
      code: result.code,
      codeVerifier,
    });
  } catch (err) {
    if (err instanceof CliAuthApiError) {
      throw new Error(err.message);
    }
    throw err;
  }

  // 6. Persist credentials with mode 0600.
  const issuedAt = new Date().toISOString();
  const stored: StoredCredentials = {
    apiKey: exchanged.api_token,
    expiresAt: exchanged.expires_at,
    issuedAt,
    app: { id: exchanged.app.id, name: exchanged.app.name },
    user: { id: exchanged.user.id, email: exchanged.user.email },
    baseUrl: apiBaseUrl,
    ...(opts.label ? { label: opts.label } : {}),
  };
  writeCredentials(stored);

  // Reset the cached BridgeManagement client so the next command picks up the
  // new token (relevant when `auth login` is called within the same process).
  resetManagementClient();

  // 7. Friendly confirmation.
  const expiryHuman = formatExpiryDate(exchanged.expires_at);
  stdout.write(
    `Logged in as ${exchanged.user.email}. App: ${exchanged.app.name}. Token valid until ${expiryHuman}.\n`,
  );
}

function buildAuthorizeUrl(
  authBaseUrl: string,
  params: { challenge: string; redirect: string; state: string; appId?: string; label?: string },
): string {
  const url = new URL(`${authBaseUrl}/cli/authorize`);
  url.searchParams.set('challenge', params.challenge);
  url.searchParams.set('redirect', params.redirect);
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', 'management');
  if (params.appId) url.searchParams.set('app_id', params.appId);
  if (params.label) url.searchParams.set('label', params.label);
  return url.toString();
}

function formatExpiryDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:MM (local) — easier to glance at than a full ISO.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
