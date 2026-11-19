import type { BridgeClient } from '../client.js';

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

/** The app an app key belongs to: keys read `bk.<app>.<id>.<secret>`. `BRIDGE_APP_KEY` is checked against the chosen app. */
export function appOfKey(key: string): string | null {
  const parts = key.split('.');
  return parts.length === 4 && parts[0] === 'bk' && parts[1] !== '' ? (parts[1] as string) : null;
}
