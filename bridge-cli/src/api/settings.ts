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
  /** The text-message second step (MFA). */
  readonly secondStep?: boolean;
  /** When a person with no passkey is offered one: after signing in another way, and made by the browser on its own. */
  readonly passkeyOffer?: { readonly afterSignIn: boolean; readonly automatic: boolean };
  /** Each provider's saved credentials as a console sees them, never the secret, and the return address to register. */
  readonly providers?: Readonly<Record<string, ProviderView>>;
  readonly signUp: boolean;
  readonly signUpPlan: string | null;
  readonly lifetimes: { readonly accessTokenSeconds: number; readonly sessionIdleSeconds: number; readonly sessionAbsoluteSeconds: number | null };
  readonly password: Readonly<Record<string, unknown>>;
  /** The rules' badge (`nist`, `audit` or null), the common-password list's date and production's floor. */
  readonly passwordFacts?: { readonly badge?: string | null; readonly commonPasswords?: { readonly updated?: string }; readonly productionFloor?: { readonly kept?: boolean; readonly preset?: string } };
  readonly bounds?: { readonly lifetimes?: Readonly<Record<string, { readonly min: number; readonly max: number }>> };
  /** Assistants and CLI; absent from an older server. */
  readonly tools?: ToolsSettings;
}

/** Which AI assistants may connect to the app's MCP endpoints, and whether its CLI may sign in with a short code. */
export interface ToolsSettings {
  readonly anyAssistant: boolean;
  /** Client ids allowed when `anyAssistant` is off (at most 50). */
  readonly assistants: string[];
  readonly shortCode: boolean;
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
  /** Apple only: the Team ID and Key ID in use, the domain to list on the Services ID, and a Services ID that looks wrong. */
  readonly teamId?: string | null;
  readonly keyId?: string | null;
  readonly domain?: string;
  readonly clientIdWarning?: string | null;
}

export interface SignInSettingsFields {
  methods?: Partial<SignInSettings['methods']>;
  social?: Record<string, boolean>;
  lifetimes?: Partial<SignInSettings['lifetimes']>;
  password?: Record<string, unknown>;
  /** Merged into what the app has. */
  tools?: Partial<ToolsSettings>;
  passkeyOffer?: { afterSignIn?: boolean; automatic?: boolean };
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
  saveProvider: (c: BridgeClient, appId: string, provider: string, fields: { clientId: string; clientSecret: string; tenantId?: string; secretExpiresAt?: string } | { clientId: string; teamId: string; keyId: string; privateKey: string }) =>
    c.person<SignInSettings>('signInProviderSave', { params: { appId, provider }, body: fields }).then((answer) => answer.body),
};

export const userPasskeys = {
  list: (c: BridgeClient, appId: string, userId: string) => c.person<UserPasskey[]>('userPasskeysList', { params: { appId, userId } }).then((answer) => answer.body),
  remove: (c: BridgeClient, appId: string, userId: string, passkeyId: string) => c.person<unknown>('userPasskeysRemove', { params: { appId, userId, passkeyId } }).then(() => undefined),
};

/** One tool connected to one user of the app: the app's CLI or an AI assistant. Never a token. */
export interface UserConnection {
  readonly id: string;
  readonly kind: 'cli' | 'assistant';
  readonly client: { readonly id: string; readonly name: string };
  readonly workspace: string | null;
  readonly delete: boolean;
  readonly signedInAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

/** A user's connected tools, for the app's admins: list, end one or all, and end every session ("sign out everywhere"). */
export const userConnections = {
  list: (c: BridgeClient, appId: string, userId: string) => c.person<UserConnection[]>('userConnectionsList', { params: { appId, userId } }).then((answer) => answer.body),
  end: (c: BridgeClient, appId: string, userId: string, sessionId: string) => c.person<unknown>('userConnectionsEnd', { params: { appId, userId, sessionId } }).then(() => undefined),
  endAll: (c: BridgeClient, appId: string, userId: string) => c.person<{ ended: number }>('userConnectionsEndAll', { params: { appId, userId } }).then((answer) => answer.body),
  signOutEverywhere: (c: BridgeClient, appId: string, userId: string) => c.person<{ ended: number }>('userSessionsEnd', { params: { appId, userId } }).then((answer) => answer.body),
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
