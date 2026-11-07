import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

/** What an address of an app is used for. */
export const ADDRESS_USES = ['sign-in-return', 'browser-origin', 'email-links', 'sign-out', 'checkout-return'] as const;
export type AddressUse = (typeof ADDRESS_USES)[number];

export interface Address {
  readonly url: string;
  readonly uses: AddressUse[];
}

export interface App {
  readonly id: string;
  readonly name: string;
  readonly state?: string;
  readonly addresses: Address[];
  readonly defaultReturn: string | null;
  readonly profile?: Record<string, string>;
  readonly trust?: { readonly issuer: string; readonly audience: string } | null;
  readonly [field: string]: unknown;
}

/** An app's name and public profile, as it is created or changed. `null` clears a profile field. */
export interface AppFields {
  readonly name?: string;
  readonly addresses?: Address[];
  readonly defaultReturn?: string | null;
  readonly logo?: string | null;
  readonly website?: string | null;
  readonly privacyPolicy?: string | null;
  readonly termsOfService?: string | null;
}

export function checkUses(uses: readonly string[]): AddressUse[] {
  if (uses.length === 0) throw new CliError('invalid', `Say what the address is for: --use ${ADDRESS_USES.join(' | ')}.`);
  for (const use of uses) {
    if (!(ADDRESS_USES as readonly string[]).includes(use)) {
      throw new CliError('invalid', `${use} is not a use. An address is used for: ${ADDRESS_USES.join(', ')}.`);
    }
  }
  return [...new Set(uses)] as AddressUse[];
}

export const apps = {
  async list(c: BridgeClient): Promise<App[]> {
    return (await c.person<App[]>('appsList')).body;
  },
  async create(c: BridgeClient, fields: AppFields & { name: string }): Promise<App> {
    return (await c.person<App>('appsCreate', { body: fields })).body;
  },
  async get(c: BridgeClient, appId: string): Promise<App> {
    return (await c.person<App>('appsGet', { params: { appId } })).body;
  },
  async update(c: BridgeClient, appId: string, fields: AppFields): Promise<App> {
    return (await c.person<App>('appsUpdate', { params: { appId }, body: fields })).body;
  },
  async remove(c: BridgeClient, appId: string): Promise<unknown> {
    return (await c.person('appsDelete', { params: { appId } })).body;
  },

  /** Adds an address, or adds uses to one the app already lists. The app's whole list is written back. */
  async addAddress(c: BridgeClient, appId: string, url: string, uses: AddressUse[]): Promise<App> {
    const app = await apps.get(c, appId);
    const addresses = (app.addresses ?? []).map((each) => ({ url: each.url, uses: [...each.uses] }));
    const found = addresses.find((each) => each.url === url);
    if (found) {
      for (const use of uses) if (!found.uses.includes(use)) found.uses.push(use);
    } else {
      addresses.push({ url, uses: [...uses] });
    }
    return apps.update(c, appId, { addresses });
  },

  /**
   * Removes uses from an address, or the whole address when no uses are
   * named or none is left. A default sign-in return that is no longer a
   * sign-in return is cleared with it.
   */
  async removeAddress(c: BridgeClient, appId: string, url: string, uses: AddressUse[] = []): Promise<App> {
    const app = await apps.get(c, appId);
    const before = app.addresses ?? [];
    if (!before.some((each) => each.url === url)) throw new CliError('not-found', `The app lists no address ${url}.`);
    const addresses = before
      .map((each) => (each.url !== url ? { url: each.url, uses: [...each.uses] } : { url: each.url, uses: uses.length === 0 ? [] : each.uses.filter((use) => !uses.includes(use)) }))
      .filter((each) => each.uses.length > 0);
    const stillReturn = addresses.some((each) => each.url === app.defaultReturn && each.uses.includes('sign-in-return'));
    return apps.update(c, appId, { addresses, ...(app.defaultReturn !== null && !stillReturn ? { defaultReturn: null } : {}) });
  },
};
