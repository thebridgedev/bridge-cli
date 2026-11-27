/**
 * Every Bridge endpoint the CLI calls, pinned to version 2 of Bridge's API.
 *
 * A route names its microservice and its path under that microservice's
 * base; the base comes from the issuer's metadata (`bridge_endpoints["2"]`),
 * so the CLI is given only the issuer. The contract test checks every route
 * here against a pinned copy of the API's contract, so a route the server
 * does not promise at version 2 fails the build.
 *
 * `auth` says which credential the route takes:
 *   - `person`: the signed-in developer's token, from the Bridge App. The
 *     `/apps/{appId}/…` routes act on one of the developer's apps; they are
 *     how every command works, roles, privileges, workspaces, members,
 *     invites and the Stripe connection included.
 *   - `app-key`: an app key of the app, in `x-api-key`: the routes the app's
 *     own server calls. The CLI uses them only when `BRIDGE_APP_KEY` is set
 *     (CI), acting as the app's server with that key. It never makes keys.
 *   - `none`: before sign-in (the issuer's own endpoints).
 */
export const API_VERSION = 2;

export type Service = 'app-registry' | 'identity-access' | 'billing' | 'flags' | 'accounts' | 'events-and-logs' | 'communication';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Auth = 'person' | 'app-key' | 'none';

export interface Route {
  readonly method: Method;
  readonly service: Service;
  readonly path: string;
  readonly auth: Auth;
  /** App-key routes that act in one workspace send it in `Bridge-Workspace`. */
  readonly workspace?: true;
}

const r = (method: Method, service: Service, path: string, auth: Auth, workspace?: true): Route =>
  workspace ? { method, service, path, auth, workspace } : { method, service, path, auth };

export const ROUTES = {
  // The issuer's own endpoints: sign-in, tokens, sign-out.
  signIn: r('POST', 'identity-access', '/apps/{issuerApp}/sign-in', 'none'),
  token: r('POST', 'identity-access', '/apps/{issuerApp}/token', 'none'),
  revoke: r('POST', 'identity-access', '/apps/{issuerApp}/revoke', 'none'),
  signOut: r('POST', 'identity-access', '/sign-out', 'person'),
  me: r('GET', 'accounts', '/me', 'person'),

  // The app's hosted sign-in look, its sign-in settings, its event log and its email sender.
  brandingGet: r('GET', 'app-registry', '/apps/{appId}/branding', 'person'),
  brandingUpdate: r('PATCH', 'app-registry', '/apps/{appId}/branding', 'person'),
  signInSettingsGet: r('GET', 'identity-access', '/apps/{appId}/sign-in-settings', 'person'),
  signInSettingsUpdate: r('PATCH', 'identity-access', '/apps/{appId}/sign-in-settings', 'person'),
  eventsList: r('GET', 'events-and-logs', '/apps/{appId}/events', 'person'),
  senderGet: r('GET', 'communication', '/apps/{appId}/sender', 'person'),
  senderSet: r('PUT', 'communication', '/apps/{appId}/sender', 'person'),

  // Apps and their addresses.
  appsList: r('GET', 'app-registry', '/apps', 'person'),
  appsCreate: r('POST', 'app-registry', '/apps', 'person'),
  appsGet: r('GET', 'app-registry', '/apps/{appId}', 'person'),
  appsUpdate: r('PATCH', 'app-registry', '/apps/{appId}', 'person'),
  appsDelete: r('DELETE', 'app-registry', '/apps/{appId}', 'person'),

  // App keys.
  keysList: r('GET', 'identity-access', '/apps/{appId}/keys', 'person'),
  keysCreate: r('POST', 'identity-access', '/apps/{appId}/keys', 'person'),
  keysRevoke: r('DELETE', 'identity-access', '/apps/{appId}/keys/{keyId}', 'person'),

  // Billing: plans, products, metrics, taxes, settings, the payment connection.
  plansList: r('GET', 'billing', '/apps/{appId}/plans', 'person'),
  plansCreate: r('POST', 'billing', '/apps/{appId}/plans', 'person'),
  plansGet: r('GET', 'billing', '/apps/{appId}/plans/{key}', 'person'),
  plansReplace: r('PUT', 'billing', '/apps/{appId}/plans/{key}', 'person'),
  plansUpdate: r('PATCH', 'billing', '/apps/{appId}/plans/{key}', 'person'),
  plansDelete: r('DELETE', 'billing', '/apps/{appId}/plans/{key}', 'person'),
  plansArchive: r('POST', 'billing', '/apps/{appId}/plans/{key}/archive', 'person'),
  plansDeletionPreview: r('GET', 'billing', '/apps/{appId}/plans/{key}/deletion-preview', 'person'),
  payerSubscriptionSet: r('PUT', 'billing', '/apps/{appId}/workspaces/{workspaceId}/payer/subscription', 'person'),
  productsList: r('GET', 'billing', '/apps/{appId}/products', 'person'),
  productsCreate: r('POST', 'billing', '/apps/{appId}/products', 'person'),
  productsGet: r('GET', 'billing', '/apps/{appId}/products/{key}', 'person'),
  productsUpdate: r('PATCH', 'billing', '/apps/{appId}/products/{key}', 'person'),
  productsDelete: r('DELETE', 'billing', '/apps/{appId}/products/{key}', 'person'),
  productsArchive: r('POST', 'billing', '/apps/{appId}/products/{key}/archive', 'person'),
  metricsList: r('GET', 'billing', '/apps/{appId}/metrics', 'person'),
  metricsPut: r('PUT', 'billing', '/apps/{appId}/metrics/{key}', 'person'),
  metricsDelete: r('DELETE', 'billing', '/apps/{appId}/metrics/{key}', 'person'),
  taxesList: r('GET', 'billing', '/apps/{appId}/taxes', 'person'),
  taxesPut: r('PUT', 'billing', '/apps/{appId}/taxes/{country}', 'person'),
  taxesDelete: r('DELETE', 'billing', '/apps/{appId}/taxes/{country}', 'person'),
  billingSettingsGet: r('GET', 'billing', '/apps/{appId}/settings', 'person'),
  billingSettingsUpdate: r('PATCH', 'billing', '/apps/{appId}/settings', 'person'),
  connectionGet: r('GET', 'billing', '/apps/{appId}/connection', 'person'),
  connectionHealth: r('GET', 'billing', '/apps/{appId}/connection/health', 'person'),
  connectionDelete: r('DELETE', 'billing', '/apps/{appId}/connection', 'person'),
  connectionPasteKey: r('POST', 'billing', '/apps/{appId}/connection', 'person'),
  keyConnectionPasteKey: r('POST', 'billing', '/connection', 'app-key'),

  // Flags and their rules.
  flagsList: r('GET', 'flags', '/apps/{appId}/flags', 'person'),
  flagsCreate: r('POST', 'flags', '/apps/{appId}/flags', 'person'),
  flagsGet: r('GET', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsUpdate: r('PATCH', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsDelete: r('DELETE', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsKill: r('POST', 'flags', '/apps/{appId}/flags/{key}/kill', 'person'),
  flagsRestore: r('POST', 'flags', '/apps/{appId}/flags/{key}/restore', 'person'),
  flagsDeletionPreview: r('GET', 'flags', '/apps/{appId}/flags/{key}/deletion-preview', 'person'),
  flagsExport: r('GET', 'flags', '/apps/{appId}/export', 'person'),
  flagsImport: r('POST', 'flags', '/apps/{appId}/import', 'person'),
  schedulesList: r('GET', 'flags', '/apps/{appId}/schedules', 'person'),
  schedulesCreate: r('POST', 'flags', '/apps/{appId}/flags/{key}/schedules', 'person'),
  schedulesDelete: r('DELETE', 'flags', '/apps/{appId}/schedules/{scheduleId}', 'person'),
  segmentsList: r('GET', 'flags', '/apps/{appId}/segments', 'person'),

  // Roles and privileges, workspaces, members and invites of the app, with the developer's token.
  rolesList: r('GET', 'accounts', '/apps/{appId}/roles', 'person'),
  rolesCreate: r('POST', 'accounts', '/apps/{appId}/roles', 'person'),
  rolesUpdate: r('PATCH', 'accounts', '/apps/{appId}/roles/{roleId}', 'person'),
  rolesDelete: r('DELETE', 'accounts', '/apps/{appId}/roles/{roleId}', 'person'),
  privilegesList: r('GET', 'accounts', '/apps/{appId}/privileges', 'person'),
  privilegesCreate: r('POST', 'accounts', '/apps/{appId}/privileges', 'person'),
  privilegesUpdate: r('PATCH', 'accounts', '/apps/{appId}/privileges/{privilegeId}', 'person'),
  privilegesDelete: r('DELETE', 'accounts', '/apps/{appId}/privileges/{privilegeId}', 'person'),
  usersList: r('GET', 'accounts', '/apps/{appId}/users', 'person'),
  usersSuspend: r('POST', 'accounts', '/apps/{appId}/users/{userId}/suspend', 'person'),
  usersResume: r('POST', 'accounts', '/apps/{appId}/users/{userId}/resume', 'person'),
  domainBlocksList: r('GET', 'accounts', '/apps/{appId}/domain-blocks', 'person'),
  domainBlocksPreview: r('GET', 'accounts', '/apps/{appId}/domain-blocks/{domain}/preview', 'person'),
  domainBlocksAdd: r('POST', 'accounts', '/apps/{appId}/domain-blocks', 'person'),
  domainBlocksRemove: r('DELETE', 'accounts', '/apps/{appId}/domain-blocks/{domain}', 'person'),
  workspaceDomainBlocksList: r('GET', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/domain-blocks', 'person'),
  workspaceDomainBlocksAdd: r('POST', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/domain-blocks', 'person'),
  workspaceDomainBlocksRemove: r('DELETE', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/domain-blocks/{domain}', 'person'),
  workspaceLimitGet: r('GET', 'accounts', '/apps/{appId}/workspace-limit', 'person'),
  workspaceLimitSet: r('PUT', 'accounts', '/apps/{appId}/workspace-limit', 'person'),
  flaggedSignUps: r('GET', 'identity-access', '/apps/{appId}/flagged-sign-ups', 'person'),
  signUpCounts: r('GET', 'identity-access', '/apps/{appId}/sign-up-counts', 'person'),
  workspacesList: r('GET', 'accounts', '/apps/{appId}/workspaces', 'person'),
  workspacesGet: r('GET', 'accounts', '/apps/{appId}/workspaces/{workspaceId}', 'person'),
  workspacesCreate: r('POST', 'accounts', '/apps/{appId}/workspaces', 'person'),
  workspacesUpdate: r('PATCH', 'accounts', '/apps/{appId}/workspaces/{workspaceId}', 'person'),
  workspacesDelete: r('DELETE', 'accounts', '/apps/{appId}/workspaces/{workspaceId}', 'person'),
  membersList: r('GET', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/members', 'person'),
  membersGet: r('GET', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/members/{memberId}', 'person'),
  membersUpdate: r('PATCH', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/members/{memberId}', 'person'),
  membersRemove: r('DELETE', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/members/{memberId}', 'person'),
  appInvitesList: r('GET', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/invites', 'person'),
  appInvitesSend: r('POST', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/invites', 'person'),
  appInvitesRevoke: r('DELETE', 'accounts', '/apps/{appId}/workspaces/{workspaceId}/invites/{inviteId}', 'person'),

  // The same, as the app's own server: an app key, used only when BRIDGE_APP_KEY is set.
  keyRolesList: r('GET', 'accounts', '/roles', 'app-key'),
  keyRolesCreate: r('POST', 'accounts', '/roles', 'app-key'),
  keyRolesUpdate: r('PATCH', 'accounts', '/roles/{roleId}', 'app-key'),
  keyRolesDelete: r('DELETE', 'accounts', '/roles/{roleId}', 'app-key'),
  keyPrivilegesList: r('GET', 'accounts', '/privileges', 'app-key'),
  keyPrivilegesCreate: r('POST', 'accounts', '/privileges', 'app-key'),
  keyPrivilegesUpdate: r('PATCH', 'accounts', '/privileges/{privilegeId}', 'app-key'),
  keyPrivilegesDelete: r('DELETE', 'accounts', '/privileges/{privilegeId}', 'app-key'),
  keyWorkspacesList: r('GET', 'accounts', '/workspaces', 'app-key'),
  keyMembersList: r('GET', 'accounts', '/members', 'app-key', true),
  keyMembersGet: r('GET', 'accounts', '/members/{memberId}', 'app-key', true),
  keyMembersUpdate: r('PATCH', 'accounts', '/members/{memberId}', 'app-key', true),
  keyMembersRemove: r('DELETE', 'accounts', '/members/{memberId}', 'app-key', true),
  keyInvitesList: r('GET', 'accounts', '/invites', 'app-key', true),
  keyInvitesSend: r('POST', 'accounts', '/invites', 'app-key', true),
  keyInvitesRevoke: r('DELETE', 'accounts', '/invites/{inviteId}', 'app-key', true),

  // Invites into the developer's own workspace on Bridge, the one their token is for.
  invitesList: r('GET', 'accounts', '/invites', 'person'),
  invitesSend: r('POST', 'accounts', '/invites', 'person'),
  invitesRevoke: r('DELETE', 'accounts', '/invites/{inviteId}', 'person'),
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof ROUTES;

/** The route as the API's contract writes it: `/v2/<microservice><path>`, with `{appId}` for an app. */
export function contractPath(route: Route): string {
  return `/v${String(API_VERSION)}/${route.service}${route.path.replace('{issuerApp}', '{appId}')}`;
}
