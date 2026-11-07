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
