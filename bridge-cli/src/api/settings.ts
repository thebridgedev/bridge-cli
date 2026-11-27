import type { BridgeClient } from '../client.js';

/** The app's hosted sign-in page look: a scheme, colours, a radius and a font from fixed lists (never free-form CSS). */
export interface Branding {
  readonly scheme: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly radius: string;
  readonly font: string;
  readonly revision?: number;
  readonly [field: string]: unknown;
}

export interface BrandingFields {
  scheme?: string;
  colors?: Record<string, string>;
  radius?: string;
  font?: string;
}

/** The app's sign-in settings, as Identity and Access answers them. */
export interface SignInSettings {
  readonly methods: { readonly password: boolean; readonly magicLink: boolean; readonly passkeys: boolean };
  /** Each social provider on or off, by Identity and Access's keys (`azure` is Microsoft). */
  readonly social?: Readonly<Record<string, boolean>>;
  /** The app's MFA switch: whether the second step is asked for at all. */
  readonly secondStep?: boolean;
  /** What sign-in, sign-up and forgot-password emails carry: a 6-digit code or a link. */
  readonly emailConfirmation?: 'code' | 'link';
  /** Where MFA is required, its allowed ways and how long a device is remembered. */
  readonly mfa?: MfaSettings;
  readonly mfaFacts?: { readonly strongest?: string; readonly methods?: readonly string[]; readonly rememberDeviceMaxDays?: number };
  /** Password expiry in days (null: never) and how many old passwords are refused. Compliance or Custom only. */
  readonly passwordExpiryDays?: number | null;
  readonly passwordHistory?: number;
  /** Each provider's saved credentials as a console sees them, never the secret, and the return address to register. */
  readonly providers?: Readonly<Record<string, ProviderView>>;
  readonly signUp: boolean;
  readonly signUpPlan: string | null;
  readonly lifetimes: { readonly accessTokenSeconds: number; readonly sessionIdleSeconds: number; readonly sessionAbsoluteSeconds: number | null };
  readonly password: Readonly<Record<string, unknown>>;
  /** The rules' badge (`nist`, `audit` or null), the common-password list's date and production's floor. */
  readonly passwordFacts?: {
    readonly badge?: string | null;
    readonly commonPasswords?: { readonly updated?: string };
    readonly productionFloor?: { readonly kept?: boolean; readonly preset?: string };
    /** Password expiry and history: the presets that take them, the choices, and the server's warning. */
    readonly aging?: { readonly presets?: readonly string[]; readonly expiryDays?: readonly number[]; readonly historyMax?: number; readonly warning?: string };
  };
  readonly bounds?: { readonly lifetimes?: Readonly<Record<string, { readonly min: number; readonly max: number }>> };
}

export type SecondStepMethod = 'totp' | 'email' | 'sms';

export interface MfaSettings {
  readonly requiredIn: 'workspaces' | 'all';
  readonly methods: Readonly<Record<SecondStepMethod, boolean>>;
  readonly rememberDeviceDays: number;
}

/** The lock-out dry run's answer. Users are ids, at most 50 a group. */
export interface MfaDryRun {
  readonly total: number;
  readonly mfaOn: boolean;
  readonly ready: { readonly count: number; readonly users: readonly string[] };
  readonly emailCode: { readonly count: number; readonly users: readonly string[] };
  readonly setUp: { readonly count: number; readonly users: readonly string[] };
  readonly lockedOut: { readonly count: number; readonly users: readonly string[] };
  readonly notSignedUp: number;
}

export interface ProviderView {
  readonly name?: string;
  readonly configured?: boolean;
  readonly clientId?: string | null;
  readonly returnAddress?: string;
  /** Microsoft only: the saved tenant, who can sign in, and the secret's expiry. */
  readonly tenantId?: string | null;
  readonly audience?: 'any' | 'work' | 'personal' | 'directory';
  readonly secretExpiresAt?: string | null;
  readonly secretExpiry?: 'ok' | 'soon' | 'expired' | null;
}

export interface SignInSettingsFields {
  methods?: Partial<SignInSettings['methods']>;
  social?: Record<string, boolean>;
  lifetimes?: Partial<SignInSettings['lifetimes']>;
  password?: Record<string, unknown>;
  secondStep?: boolean;
  emailConfirmation?: 'code' | 'link';
  mfa?: { requiredIn?: 'workspaces' | 'all'; methods?: Partial<Record<SecondStepMethod, boolean>>; rememberDeviceDays?: number };
  passwordExpiryDays?: number | null;
  passwordHistory?: number;
}

/** A passkey of one User, as the app's admins see it: never a key. */
export interface UserPasskey {
  readonly id: string;
  readonly name: string;
  readonly authenticator?: { readonly name: string; readonly icon: string | null };
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
  readonly deviceType?: string;
  readonly backedUp?: boolean;
  readonly [field: string]: unknown;
}

export interface LoggedEvent {
  readonly id: string;
  readonly type: string;
  readonly time: string;
  readonly workspaceId: string | null;
  readonly userId: string | null;
  readonly data: Record<string, unknown>;
}

export interface Sender {
  readonly address?: string;
  readonly name?: string | null;
  readonly state?: string;
  readonly [field: string]: unknown;
}

export const branding = {
  get: (c: BridgeClient, appId: string) => c.person<Branding>('brandingGet', { params: { appId } }),
  /** Changes the look as it was read: the body goes with the revision (`If-Match`) the read named, so a change made meanwhile is never overwritten. */
  async save(c: BridgeClient, appId: string, body: BrandingFields, etag: string | null): Promise<Branding> {
    return (await c.person<Branding>('brandingUpdate', { params: { appId }, body, ...(etag === null ? {} : { headers: { 'if-match': etag } }) })).body;
  },
};

export const signInSettings = {
  get: (c: BridgeClient, appId: string) => c.person<SignInSettings>('signInSettingsGet', { params: { appId } }).then((answer) => answer.body),
  update: (c: BridgeClient, appId: string, fields: SignInSettingsFields) => c.person<SignInSettings>('signInSettingsUpdate', { params: { appId }, body: fields }).then((answer) => answer.body),
  /** Saves a provider's client ID and secret (and Microsoft's tenant and secret expiry): switches nothing on. */
  saveProvider: (c: BridgeClient, appId: string, provider: string, fields: { clientId: string; clientSecret: string; tenantId?: string; secretExpiresAt?: string }) =>
    c.person<SignInSettings>('signInProviderSave', { params: { appId, provider }, body: fields }).then((answer) => answer.body),
  /** Who would be locked out if MFA were required in every workspace (`all`) or for these users, with `mfa` the whole choice considered. Changes nothing. */
  mfaDryRun: (c: BridgeClient, appId: string, input: { all?: true; users?: string[]; mfa?: MfaSettings }) =>
    c
      .person<MfaDryRun>('mfaDryRun', { params: { appId }, body: { ...(input.all === true ? { all: true } : {}), ...(input.users === undefined ? {} : { users: input.users }), ...(input.mfa === undefined ? {} : { settings: { mfa: input.mfa } }) } })
      .then((answer) => answer.body),
};

/** A User's second step reset by an admin of the app: every way, recovery code and remembered device goes, their sessions end, and they are emailed. */
export const userSecondStep = {
  reset: (c: BridgeClient, appId: string, userId: string) => c.person<{ reset: boolean }>('userSecondStepReset', { params: { appId, userId }, body: {} }).then((answer) => answer.body),
};

export const userPasskeys = {
  list: (c: BridgeClient, appId: string, userId: string) => c.person<UserPasskey[]>('userPasskeysList', { params: { appId, userId } }).then((answer) => answer.body),
  remove: (c: BridgeClient, appId: string, userId: string, passkeyId: string) => c.person<unknown>('userPasskeysRemove', { params: { appId, userId, passkeyId } }).then(() => undefined),
};

/** The app's event log, newest first. Events and logs gives at most 100 a page; this follows its cursor up to `limit`. */
export async function listEvents(c: BridgeClient, appId: string, filter: { type?: string; workspaceId?: string; userId?: string; from?: string; limit: number }): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.person<{ events: LoggedEvent[]; next: string | null }>('eventsList', {
      params: { appId },
      query: { type: filter.type, workspaceId: filter.workspaceId, userId: filter.userId, from: filter.from, limit: String(Math.min(100, filter.limit - events.length)), cursor },
    });
    events.push(...page.body.events);
    cursor = page.body.next ?? undefined;
  } while (cursor !== undefined && events.length < filter.limit);
  return events.slice(0, filter.limit);
}

export const sender = {
  get: (c: BridgeClient, appId: string) => c.person<Sender | null>('senderGet', { params: { appId } }).then((answer) => answer.body),
  set: (c: BridgeClient, appId: string, fields: { address: string; name?: string }) => c.person<Sender>('senderSet', { params: { appId }, body: fields }).then((answer) => answer.body),
};
