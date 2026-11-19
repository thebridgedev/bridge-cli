import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';
import type { RouteName } from '../core/routes.js';
import { appOfKey } from './keys.js';

/**
 * How a command reaches one app's roles, workspaces, members and Stripe
 * connection. With the developer's sign-in, on the operator routes
 * (`/apps/{appId}/…`), where Bridge checks what that person may do. With
 * `BRIDGE_APP_KEY` set (CI), as the app's own server on the key routes,
 * with that key. The CLI never makes an app key for a command.
 */
export type Door =
  | { readonly kind: 'session'; readonly c: BridgeClient; readonly appId: string }
  | { readonly kind: 'key'; readonly c: BridgeClient; readonly key: string };

export function chooseDoor(c: BridgeClient, appId: string, env: NodeJS.ProcessEnv): Door {
  const given = env['BRIDGE_APP_KEY']?.trim();
  if (!given) return { kind: 'session', c, appId };
  const owner = appOfKey(given);
  if (owner !== null && owner !== appId) {
    throw new CliError('misconfigured', `BRIDGE_APP_KEY belongs to app ${owner}, not to ${appId}.`);
  }
  return { kind: 'key', c, key: given };
}

export interface DoorCall {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** The workspace the call acts in: in the path on the operator routes, in `Bridge-Workspace` on the key routes. */
  readonly workspace?: string;
}

/** Calls the operator route `name`, or its key-route twin `key<Name>`, and returns the body. */
export async function viaDoor<T = unknown>(door: Door, name: OperatorRoute, call: DoorCall = {}): Promise<T> {
  const common = { ...(call.query === undefined ? {} : { query: call.query }), ...(call.body === undefined ? {} : { body: call.body }) };
  if (door.kind === 'key') {
    return (await door.c.withKey<T>(TWIN[name], door.key, { ...common, ...(call.params === undefined ? {} : { params: call.params }), ...(call.workspace === undefined ? {} : { workspace: call.workspace }) })).body;
  }
  if (call.workspace === undefined && WORKSPACE_ROUTES.has(name)) {
    throw new CliError('invalid', 'Name the workspace with --workspace <id> (`bridge workspace list` shows them).');
  }
  const params = { appId: door.appId, ...(call.workspace === undefined ? {} : { workspaceId: call.workspace }), ...call.params };
  return (await door.c.person<T>(name, { ...common, params })).body;
}

/** Each operator route and the key route that does the same for the app's own server. */
const TWIN = {
  rolesList: 'keyRolesList',
  rolesCreate: 'keyRolesCreate',
  rolesUpdate: 'keyRolesUpdate',
  rolesDelete: 'keyRolesDelete',
  privilegesList: 'keyPrivilegesList',
  privilegesCreate: 'keyPrivilegesCreate',
  privilegesUpdate: 'keyPrivilegesUpdate',
  privilegesDelete: 'keyPrivilegesDelete',
  workspacesList: 'keyWorkspacesList',
  membersList: 'keyMembersList',
  membersGet: 'keyMembersGet',
  membersUpdate: 'keyMembersUpdate',
  membersRemove: 'keyMembersRemove',
  appInvitesList: 'keyInvitesList',
  appInvitesSend: 'keyInvitesSend',
  appInvitesRevoke: 'keyInvitesRevoke',
  connectionPasteKey: 'keyConnectionPasteKey',
} as const satisfies Partial<Record<RouteName, RouteName>>;

type OperatorRoute = keyof typeof TWIN;
const WORKSPACE_ROUTES: ReadonlySet<OperatorRoute> = new Set(['membersList', 'membersGet', 'membersUpdate', 'membersRemove', 'appInvitesList', 'appInvitesSend', 'appInvitesRevoke']);
