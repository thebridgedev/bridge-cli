import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

/**
 * Roles, privileges, workspaces and members of an app. Version 2 offers
 * these to the app's own server only, so each call takes an app key
 * (see `withAppKey`).
 */
export interface Role {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly privileges: string[];
  readonly isDefault?: boolean;
  readonly [field: string]: unknown;
}

export interface RoleFields {
  key?: string;
  name?: string;
  description?: string;
  privileges?: string[];
  isDefault?: boolean;
}

export interface Privilege {
  readonly id: string;
  readonly key: string;
  readonly description?: string;
  readonly [field: string]: unknown;
}

const body = <T>(answer: { body: T }) => answer.body;

function byKeyOrId<T extends { id: string; key: string }>(items: readonly T[], wanted: string, what: string): T {
  const found = items.find((each) => each.key === wanted) ?? items.find((each) => each.id === wanted);
  if (found === undefined) throw new CliError('not-found', `The app has no ${what} ${wanted}.`);
  return found;
}

export const roles = {
  list: (c: BridgeClient, key: string) => c.withKey<Role[]>('rolesList', key).then(body),
  create: (c: BridgeClient, key: string, fields: RoleFields & { key: string; name: string }) => c.withKey<Role>('rolesCreate', key, { body: fields }).then(body),
  async update(c: BridgeClient, key: string, role: string, fields: RoleFields): Promise<Role> {
    const found = byKeyOrId(await roles.list(c, key), role, 'role');
    return c.withKey<Role>('rolesUpdate', key, { params: { roleId: found.id }, body: fields }).then(body);
  },
  async remove(c: BridgeClient, key: string, role: string): Promise<unknown> {
    const found = byKeyOrId(await roles.list(c, key), role, 'role');
    return c.withKey('rolesDelete', key, { params: { roleId: found.id } }).then(body);
  },
};

export const privileges = {
  list: (c: BridgeClient, key: string) => c.withKey<Privilege[]>('privilegesList', key).then(body),
  create: (c: BridgeClient, key: string, fields: { key: string; description?: string }) => c.withKey<Privilege>('privilegesCreate', key, { body: fields }).then(body),
  async update(c: BridgeClient, key: string, privilege: string, fields: { key?: string; description?: string }): Promise<Privilege> {
    const found = byKeyOrId(await privileges.list(c, key), privilege, 'privilege');
    return c.withKey<Privilege>('privilegesUpdate', key, { params: { privilegeId: found.id }, body: fields }).then(body);
  },
  async remove(c: BridgeClient, key: string, privilege: string): Promise<unknown> {
    const found = byKeyOrId(await privileges.list(c, key), privilege, 'privilege');
    return c.withKey('privilegesDelete', key, { params: { privilegeId: found.id } }).then(body);
  },
};

export const workspaces = {
  list: (c: BridgeClient, key: string, query: { limit?: string; after?: string; search?: string } = {}) => c.withKey('workspacesList', key, { query }).then(body),
};

export const members = {
  list: (c: BridgeClient, key: string, workspace: string, query: { limit?: string; after?: string; search?: string } = {}) =>
    c.withKey('membersList', key, { workspace, query }).then(body),
  get: (c: BridgeClient, key: string, workspace: string, memberId: string) => c.withKey('membersGet', key, { workspace, params: { memberId } }).then(body),
  update: (c: BridgeClient, key: string, workspace: string, memberId: string, fields: { role?: string; enabled?: boolean }) =>
    c.withKey('membersUpdate', key, { workspace, params: { memberId }, body: fields }).then(body),
  remove: (c: BridgeClient, key: string, workspace: string, memberId: string) => c.withKey('membersRemove', key, { workspace, params: { memberId } }).then(body),
};

/** An open invite, as a workspace's list shows it. Accepted and revoked ones leave the list. */
export interface Invite {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  /** `open` while the link works, `expired` once its 30 days have passed. */
  readonly state: string;
  readonly expiresAt: string;
  readonly invitedBy: string | null;
  readonly createdAt: string | null;
}

export interface InviteFields {
  readonly email: string;
  /** The role the person joins with. Left out, the workspace's default role. */
  readonly role?: string;
}

/**
 * Invites into the developer's own workspace on Bridge: the one their
 * session is for. Bridge emails the link; sending again to an address sends
 * a new link, and the old one stops working.
 */
export const invites = {
  list: (c: BridgeClient) => c.person<Invite[]>('invitesList').then(body),
  send: (c: BridgeClient, fields: InviteFields) => c.person<Invite>('invitesSend', { body: fields }).then(body),
  revoke: (c: BridgeClient, inviteId: string) => c.person<{ revoked: boolean }>('invitesRevoke', { params: { inviteId } }).then(body),
};

/** Invites into one of the app's workspaces, with an app key. */
export const appInvites = {
  list: (c: BridgeClient, key: string, workspace: string) => c.withKey<Invite[]>('appInvitesList', key, { workspace }).then(body),
  send: (c: BridgeClient, key: string, workspace: string, fields: InviteFields) => c.withKey<Invite>('appInvitesSend', key, { workspace, body: fields }).then(body),
  revoke: (c: BridgeClient, key: string, workspace: string, inviteId: string) =>
    c.withKey<{ revoked: boolean }>('appInvitesRevoke', key, { workspace, params: { inviteId } }).then(body),
};
