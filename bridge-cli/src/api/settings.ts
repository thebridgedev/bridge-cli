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
  readonly signUp: boolean;
  readonly signUpPlan: string | null;
  readonly lifetimes: { readonly accessTokenSeconds: number; readonly sessionIdleSeconds: number; readonly sessionAbsoluteSeconds: number };
  readonly password: Readonly<Record<string, unknown>>;
  readonly bounds?: { readonly lifetimes?: Readonly<Record<string, { readonly min: number; readonly max: number }>> };
}

export interface SignInSettingsFields {
  methods?: Partial<SignInSettings['methods']>;
  lifetimes?: Partial<SignInSettings['lifetimes']>;
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
