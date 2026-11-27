import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

/** What an address of an app is used for. */
export const ADDRESS_USES = ['sign-in-return', 'browser-origin', 'email-links', 'sign-out', 'checkout-return'] as const;
export type AddressUse = (typeof ADDRESS_USES)[number];

export interface Address {
  readonly url: string;
  readonly uses: AddressUse[];
}

export type AppMode = 'development' | 'production';
export type SignInLocation = 'app' | 'hosted';

/** The "Your app" settings the App registry shows on an app. */
export interface YourApp {
  readonly mode: AppMode;
  readonly main: string | null;
  readonly mainChoices: string[];
  readonly passkeyDomain: string | null;
  readonly signIn: { readonly location: SignInLocation; readonly path: string; readonly returnPath: string; readonly emailLinks: SignInLocation | null; readonly emailLinksOpenOn: string | null };
  readonly productionRules: Rule[];
  /** Passkeys on other domains (TBP-873): the list, the file to publish on the main domain and the last check; null for none. */
  readonly relatedOrigins?: RelatedOrigins | null;
}

export interface RelatedOrigins {
  readonly origins: string[];
  readonly hosted: boolean;
  readonly check: { readonly verified: boolean; readonly at: string; readonly missing: string[]; readonly problem: string | null } | null;
  readonly file: { readonly url: string; readonly body: { readonly origins: string[] } } | null;
  readonly labelLimit: number;
}

/** One rule production keeps on. `passes: null` means the App registry does not know it (the password rule: Identity and Access checks it when users sign in). */
export interface Rule {
  readonly rule: string;
  readonly text: string;
  readonly passes: boolean | null;
}

/** The answer of `GET /apps/{appId}/mode`. */
export interface ModeAnswer {
  readonly mode: AppMode;
  readonly main: string | null;
  readonly rules: Rule[];
  readonly canSwitchToProduction: boolean;
}

/** The answer of `GET /apps/{appId}/sign-in-settings/production`: the password rule's status and who must choose a new password. */
export interface ProductionStatus {
  readonly mode: string | null;
  readonly passwordRules: { readonly passes: boolean; readonly preset: string; readonly required: string };
  readonly usersToChooseNewPassword: number;
}

/** The answer of `GET /apps/{appId}/sign-in-settings/passkey-impact?main=`. */
export interface PasskeyImpact {
  readonly from: string | null;
  readonly to: string | null;
  readonly stopWorking: number;
}

export interface App {
  readonly id: string;
  readonly name: string;
  readonly state?: string;
  readonly addresses: Address[];
  readonly defaultReturn: string | null;
  readonly profile?: Record<string, string>;
  readonly yourApp?: YourApp;
  readonly trust?: { readonly issuer: string; readonly audience: string } | null;
  readonly [field: string]: unknown;
}

/** An app's name and public profile, as it is created or changed. `null` clears a profile field. */
export interface AppFields {
  relatedOrigins?: { origins: string[]; hosted: boolean } | null;
  readonly name?: string;
  readonly addresses?: Address[];
  readonly defaultReturn?: string | null;
  readonly logo?: string | null;
  readonly website?: string | null;
  readonly privacyPolicy?: string | null;
  readonly termsOfService?: string | null;
  /** At creation: development or production, and the main address (listed if it is not). */
  readonly mode?: AppMode;
  readonly main?: string | null;
  readonly signIn?: { location?: SignInLocation; path?: string; returnPath?: string; emailLinks?: SignInLocation | null };
  /** You have seen how many passkeys stop working and go ahead with a main address on another domain. */
  readonly confirmPasskeys?: boolean;
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
  async mode(c: BridgeClient, appId: string): Promise<ModeAnswer> {
    return (await c.person<ModeAnswer>('appsModeGet', { params: { appId } })).body;
  },
  async switchMode(c: BridgeClient, appId: string, mode: AppMode): Promise<App> {
    return (await c.person<App>('appsModeSwitch', { params: { appId }, body: { mode, confirm: true } })).body;
  },
  async production(c: BridgeClient, appId: string): Promise<ProductionStatus> {
    return (await c.person<ProductionStatus>('productionStatus', { params: { appId } })).body;
  },
  async checkRelatedOrigins(c: BridgeClient, appId: string): Promise<App> {
    return (await c.person<App>('relatedOriginsCheck', { params: { appId }, body: {} })).body;
  },
  async passkeyImpact(c: BridgeClient, appId: string, main: string): Promise<PasskeyImpact> {
    return (await c.person<PasskeyImpact>('passkeyImpact', { params: { appId }, query: { main } })).body;
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
