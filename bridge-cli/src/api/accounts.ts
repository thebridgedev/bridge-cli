import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';
import { viaDoor, type Door } from './door.js';

/**
 * Roles, privileges, workspaces and members of an app. Each call goes
 * through a {@link Door}: the developer's sign-in on the operator routes, or
 * `BRIDGE_APP_KEY` on the key routes.
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
  list: (d: Door) => viaDoor<Role[]>(d, 'rolesList'),
  create: (d: Door, fields: RoleFields & { key: string; name: string }) => viaDoor<Role>(d, 'rolesCreate', { body: fields }),
  async update(d: Door, role: string, fields: RoleFields): Promise<Role> {
    const found = byKeyOrId(await roles.list(d), role, 'role');
    return viaDoor<Role>(d, 'rolesUpdate', { params: { roleId: found.id }, body: fields });
  },
  async remove(d: Door, role: string): Promise<unknown> {
    const found = byKeyOrId(await roles.list(d), role, 'role');
    return viaDoor(d, 'rolesDelete', { params: { roleId: found.id } });
  },
};

export const privileges = {
  list: (d: Door) => viaDoor<Privilege[]>(d, 'privilegesList'),
  create: (d: Door, fields: { key: string; description?: string }) => viaDoor<Privilege>(d, 'privilegesCreate', { body: fields }),
  async update(d: Door, privilege: string, fields: { key?: string; description?: string }): Promise<Privilege> {
    const found = byKeyOrId(await privileges.list(d), privilege, 'privilege');
    return viaDoor<Privilege>(d, 'privilegesUpdate', { params: { privilegeId: found.id }, body: fields });
  },
  async remove(d: Door, privilege: string): Promise<unknown> {
    const found = byKeyOrId(await privileges.list(d), privilege, 'privilege');
    return viaDoor(d, 'privilegesDelete', { params: { privilegeId: found.id } });
  },
};

/** One of the app's workspaces, as Accounts answers it. */
export interface Workspace {
  readonly id: string;
  readonly name: string | null;
  readonly [field: string]: unknown;
}

export interface WorkspaceFields {
  readonly name?: string;
  readonly locale?: string;
  readonly logo?: string;
}

export const workspaces = {
  list: (d: Door, query: { limit?: string; after?: string; search?: string } = {}) => viaDoor(d, 'workspacesList', { query }),
  get: (c: BridgeClient, appId: string, workspaceId: string) => c.person<Workspace>('workspacesGet', { params: { appId, workspaceId } }).then(body),
  create: (c: BridgeClient, appId: string, fields: WorkspaceFields & { owner: { email: string } }) => c.person<Workspace>('workspacesCreate', { params: { appId }, body: fields }).then(body),
  update: (c: BridgeClient, appId: string, workspaceId: string, fields: WorkspaceFields) => c.person<Workspace>('workspacesUpdate', { params: { appId, workspaceId }, body: fields }).then(body),
  remove: (c: BridgeClient, appId: string, workspaceId: string) => c.person<Workspace>('workspacesDelete', { params: { appId, workspaceId } }).then(body),
  /** Which plan the workspace is on: Billing's payer subscription. */
  setPlan: (c: BridgeClient, appId: string, workspaceId: string, fields: { plan: string; interval?: string; currency?: string }) => c.person('payerSubscriptionSet', { params: { appId, workspaceId }, body: fields }).then(body),

  /** A workspace by its name, which must be unique, else by its id. The names there are, when it is neither. */
  async find(d: Door, wanted: string): Promise<Workspace> {
    const listed = (await viaDoor<Workspace[]>(d, 'workspacesList', { query: { search: wanted } })) ?? [];
    const named = listed.filter((each) => each.name === wanted);
    if (named.length > 1) throw new CliError('conflict', `More than one workspace is named "${wanted}".`, { hint: 'Name it by its id: `bridge workspace list` shows them.' });
    const found = named[0] ?? listed.find((each) => each.id === wanted) ?? (await viaDoor<Workspace[]>(d, 'workspacesList')).find((each) => each.id === wanted);
    if (found === undefined) {
      const known = (await viaDoor<Workspace[]>(d, 'workspacesList')).map((each) => each.name ?? each.id).join(', ');
      throw new CliError('not-found', `The app has no workspace "${wanted}".`, { hint: `Its workspaces: ${known === '' ? '(none)' : known}.` });
    }
    return found;
  },
};

export const members = {
  list: (d: Door, workspace: string, query: { limit?: string; after?: string; search?: string } = {}) => viaDoor(d, 'membersList', { workspace, query }),
  get: (d: Door, workspace: string, memberId: string) => viaDoor(d, 'membersGet', { workspace, params: { memberId } }),
  update: (d: Door, workspace: string, memberId: string, fields: { role?: string; enabled?: boolean }) =>
    viaDoor(d, 'membersUpdate', { workspace, params: { memberId }, body: fields }),
  remove: (d: Door, workspace: string, memberId: string) => viaDoor(d, 'membersRemove', { workspace, params: { memberId } }),
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
  /** The person's name, used when they accept and have none yet. */
  readonly firstName?: string;
  readonly lastName?: string;
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

/**
 * Invites into one of the app's workspaces. Bridge emails the person a link
 * and they join when they accept it. On the key routes (`BRIDGE_APP_KEY`)
 * it is the same invite.
 */
export const appInvites = {
  list: (d: Door, workspace: string) => viaDoor<Invite[]>(d, 'appInvitesList', { workspace }),
  send: (d: Door, workspace: string, fields: InviteFields) => viaDoor<Invite>(d, 'appInvitesSend', { workspace, body: fields }),
  revoke: (d: Door, workspace: string, inviteId: string) => viaDoor<{ revoked: boolean }>(d, 'appInvitesRevoke', { workspace, params: { inviteId } }),
};
