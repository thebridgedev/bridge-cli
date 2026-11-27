import type { Discovery } from '../core/discovery.js';
import { CliError } from '../core/errors.js';
import { call, type Fetch } from '../core/http.js';
import type { Sessions } from './session.js';
import type { StoredSession } from './store.js';

/**
 * Sign-in with a short code (RFC 8628), for a machine without a browser (SSH, a container, a server): Bridge gives a
 * code and an address; the developer opens the address on any other device, signs in to the dashboard, enters the
 * code and approves (deleting off unless ticked); the CLI polls the token endpoint until then. The session is kept
 * exactly as a browser sign-in's. Scripts and CI use an app key instead.
 */

export const NO_DEVICE_SIGN_IN = 'This Bridge does not offer sign-in with a code; use a browser, or an app key for scripts and CI.';

interface DeviceAnswer {
  readonly device_code?: unknown;
  readonly user_code?: unknown;
  readonly verification_uri?: unknown;
  readonly verification_uri_complete?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
}

export interface DeviceSignIn {
  readonly show: (message: string) => void;
  /** Waits; tests pass one that returns at once. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The OAuth error a poll answered, from the CLI error's details. */
function oauthError(error: unknown): string | null {
  if (!(error instanceof CliError)) return null;
  const details = error.details as { error?: unknown } | undefined;
  return typeof details?.error === 'string' ? details.error : null;
}

export async function signInWithDevice(fetchFn: Fetch, sessions: Sessions, d: Discovery, input: DeviceSignIn): Promise<StoredSession> {
  if (d.deviceAuthorization === null) throw new CliError('not-offered', NO_DEVICE_SIGN_IN, { hint: 'Run `bridge auth login` on a machine with a browser, or set BRIDGE_APP_KEY for scripts and CI.' });
  let answer: DeviceAnswer;
  try {
    ({ body: answer } = await call<DeviceAnswer>(fetchFn, { method: 'POST', url: d.deviceAuthorization, body: { client_id: d.appId } }));
  } catch (error) {
    if (oauthError(error) === 'unauthorized_client') throw new CliError('not-offered', NO_DEVICE_SIGN_IN);
    throw error;
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: page } = answer;
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof page !== 'string') throw new CliError('misconfigured', 'Bridge did not give a code to sign in with.');
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? wait;
  const lifetime = typeof answer.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 600;
  const minutes = Math.max(1, Math.round(lifetime / 60));
  input.show(`Open ${page} and enter ${userCode}. The code expires in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`);
  if (typeof answer.verification_uri_complete === 'string') input.show(`Or open ${answer.verification_uri_complete} to have the code filled in.`);
  const deadline = now() + lifetime * 1000;
  let interval = typeof answer.interval === 'number' && answer.interval > 0 ? answer.interval : 5;
  for (;;) {
    await sleep(interval * 1000);
    try {
      return await sessions.exchangeDeviceCode(d, deviceCode);
    } catch (error) {
      const code = oauthError(error);
      if (code === 'authorization_pending') {
        if (now() >= deadline) break;
        continue;
      }
      if (code === 'slow_down') {
        interval += 5;
        continue;
      }
      if (code === 'access_denied') throw new CliError('cancelled', 'The sign-in was not approved.');
      if (code === 'expired_token') break;
      throw error;
    }
  }
  throw new CliError('flow-expired', 'The code expired. Run `bridge auth login --device` again.');
}
