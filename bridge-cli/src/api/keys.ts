import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

export interface Key {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly privileges: string[];
  readonly expiresAt: string;
  readonly revoked?: boolean;
  readonly [field: string]: unknown;
}

/** A key just made: the secret is in `key`, shown this once. */
export interface MadeKey extends Key {
  readonly key: string;
}

export interface KeyFields {
  readonly name: string;
  readonly privileges?: string[];
  readonly expiresInDays?: number;
}

export const keys = {
  async list(c: BridgeClient, appId: string): Promise<Key[]> {
    return (await c.person<Key[]>('keysList', { params: { appId } })).body;
  },
  async create(c: BridgeClient, appId: string, fields: KeyFields): Promise<MadeKey> {
    return (await c.person<MadeKey>('keysCreate', { params: { appId }, body: fields })).body;
  },
  async revoke(c: BridgeClient, appId: string, keyId: string): Promise<void> {
    await c.person('keysRevoke', { params: { appId, keyId } });
  },
};

/** The app an app key belongs to: keys read `bk.<app>.<id>.<secret>`. */
export function appOfKey(key: string): string | null {
  const parts = key.split('.');
  return parts.length === 4 && parts[0] === 'bk' && parts[1] !== '' ? (parts[1] as string) : null;
}

/**
 * Runs `fn` with an app key of the app, for the routes version 2 offers
 * only to the app's own server.
 *
 * The key is `BRIDGE_APP_KEY` when it is set (it must be this app's).
 * Otherwise the CLI makes a key that lasts one day and holds only the
 * privileges this command needs, and revokes it once `fn` is done, so no
 * key is left behind. Making a key needs a recent sign-in.
 */
export async function withAppKey<T>(
  c: BridgeClient,
  appId: string,
  privileges: string[],
  env: NodeJS.ProcessEnv,
  fn: (key: string) => Promise<T>,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<T> {
  const given = env['BRIDGE_APP_KEY']?.trim();
  if (given) {
    const owner = appOfKey(given);
    if (owner !== null && owner !== appId) {
      throw new CliError('misconfigured', `BRIDGE_APP_KEY belongs to app ${owner}, not to ${appId}.`);
    }
    return fn(given);
  }
  let made: MadeKey;
  try {
    made = await keys.create(c, appId, { name: 'bridge-cli (temporary)', privileges, expiresInDays: 1 });
  } catch (error) {
    if (error instanceof CliError && error.kind === 'reauthenticate') {
      throw new CliError('reauthenticate', 'This command makes a short-lived app key, which needs a recent sign-in.', {
        status: error.status,
        hint: 'Sign in again with `bridge auth login` and run it within 5 minutes, or set BRIDGE_APP_KEY to one of the app\'s keys.',
      });
    }
    throw error;
  }
  try {
    return await fn(made.key);
  } finally {
    await keys.revoke(c, appId, made.id).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`The temporary key ${made.id} could not be revoked (${reason}); it expires within a day. Revoke it with \`bridge key revoke ${made.id}\`.`);
    });
  }
}
