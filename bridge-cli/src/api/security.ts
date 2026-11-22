import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

/**
 * Login security: suspending a person across the app, blocked email domains (the app's and a workspace's), the number of
 * workspaces one person can create, and the sign-ups Sign-up protection flagged. All on the developer's sign-in.
 */

export interface Suspension {
  /** `person:<id>`, `key:<id>` or `app`. */
  readonly by: string;
  readonly at: string;
  readonly reason: string | null;
  /** The blocked domain that suspended them, when it was that. */
  readonly viaDomain: string | null;
}

export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly suspended: boolean;
  readonly suspension?: Suspension | null;
  readonly workspaces?: { readonly id: string; readonly status: string }[];
  readonly [field: string]: unknown;
}

export interface BlockedDomain {
  readonly domain: string;
  readonly by: string;
  readonly at: string;
  readonly reason: string | null;
}

/** How many people of the app are on a domain, and how many of them are not suspended. */
export interface DomainPreview {
  readonly domain: string;
  readonly users: number;
  readonly active: number;
  readonly blocked: boolean;
}

export interface FlaggedSignUp {
  readonly user: string;
  readonly email: string;
  readonly leakedPassword: string | null;
  readonly signUpRisk: { readonly score: number; readonly reasons: readonly string[] } | null;
  readonly signedUpAt: string | null;
}

/** Who did it, in words. */
export function byText(by: string | null | undefined): string {
  if (by === null || by === undefined || by === '') return 'unknown';
  if (by === 'app') return 'the app';
  if (by.startsWith('key:')) return 'an app key';
  if (by.startsWith('person:')) return 'a team member';
  return by;
}

/** The domain of what was typed: an email address or a domain, in lower case. */
export function domainOf(typed: string): string {
  const text = typed.trim().toLowerCase();
  const domain = text.includes('@') ? text.slice(text.lastIndexOf('@') + 1) : text;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new CliError('invalid', `"${typed}" is not a domain.`, { hint: 'Give a domain such as example.com, or an email address on it.' });
  }
  return domain;
}

export const REASONS: Readonly<Record<string, string>> = {
  throwaway_domain: 'Throwaway email domain',
  domain_cannot_receive_email: 'The domain cannot receive email',
  address_variation: 'A variation of an address that already has a login',
  filled_in_too_fast: 'Form filled in faster than a person can',
  hidden_field_filled: 'A hidden field was filled in',
};

export const users = {
  /** A person by email, with who suspended them, when and why; null when the app has no such person. */
  byEmail: async (c: BridgeClient, appId: string, email: string): Promise<AppUser | null> => (await c.person<AppUser[]>('usersList', { params: { appId }, query: { email } })).body[0] ?? null,
  suspend: (c: BridgeClient, appId: string, userId: string, reason?: string) =>
    c.person<AppUser>('usersSuspend', { params: { appId, userId }, body: reason === undefined ? {} : { reason } }).then((answer) => answer.body),
  resume: (c: BridgeClient, appId: string, userId: string) => c.person<AppUser>('usersResume', { params: { appId, userId }, body: {} }).then((answer) => answer.body),
};

export const domainBlocks = {
  list: (c: BridgeClient, appId: string) => c.person<BlockedDomain[]>('domainBlocksList', { params: { appId } }).then((answer) => answer.body),
  preview: (c: BridgeClient, appId: string, domain: string) => c.person<DomainPreview>('domainBlocksPreview', { params: { appId, domain } }).then((answer) => answer.body),
  add: (c: BridgeClient, appId: string, body: { domain: string; reason?: string; suspendExisting?: boolean }) =>
    c.person<{ domain: string; suspended: number }>('domainBlocksAdd', { params: { appId }, body }).then((answer) => answer.body),
  remove: (c: BridgeClient, appId: string, domain: string) => c.person<{ domain: string }>('domainBlocksRemove', { params: { appId, domain } }).then((answer) => answer.body),
};

export const workspaceDomainBlocks = {
  list: (c: BridgeClient, appId: string, workspaceId: string) => c.person<BlockedDomain[]>('workspaceDomainBlocksList', { params: { appId, workspaceId } }).then((answer) => answer.body),
  add: (c: BridgeClient, appId: string, workspaceId: string, body: { domain: string; reason?: string }) =>
    c.person<BlockedDomain[]>('workspaceDomainBlocksAdd', { params: { appId, workspaceId }, body }).then((answer) => answer.body),
  remove: (c: BridgeClient, appId: string, workspaceId: string, domain: string) =>
    c.person<BlockedDomain[]>('workspaceDomainBlocksRemove', { params: { appId, workspaceId, domain } }).then((answer) => answer.body),
};

export const workspaceLimit = {
  get: (c: BridgeClient, appId: string) => c.person<{ workspacesPerPerson: number | null }>('workspaceLimitGet', { params: { appId } }).then((answer) => answer.body),
  set: (c: BridgeClient, appId: string, workspacesPerPerson: number | null) =>
    c.person<{ workspacesPerPerson: number | null }>('workspaceLimitSet', { params: { appId }, body: { workspacesPerPerson } }).then((answer) => answer.body),
};

export const flaggedSignUps = {
  list: (c: BridgeClient, appId: string, query: { limit?: string; after?: string; minScore?: string }) =>
    c.person<{ signUps: FlaggedSignUp[]; next: string | null }>('flaggedSignUps', { params: { appId }, query }).then((answer) => answer.body),
};
