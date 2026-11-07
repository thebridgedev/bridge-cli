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
 *     `/apps/{appId}/…` routes act on one of the developer's apps.
 *   - `app-key`: an app key of the app, in `x-api-key`. Used where version 2
 *     has no route for the developer: roles, privileges, members, and a
 *     pasted Stripe key.
 *   - `none`: before sign-in (the issuer's own endpoints).
 */
export const API_VERSION = 2;

export type Service = 'app-registry' | 'identity-access' | 'billing' | 'flags' | 'accounts';
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
  connectionDelete: r('DELETE', 'billing', '/apps/{appId}/connection', 'person'),
  connectionPasteKey: r('POST', 'billing', '/connection', 'app-key'),

  // Flags and their rules.
  flagsList: r('GET', 'flags', '/apps/{appId}/flags', 'person'),
  flagsCreate: r('POST', 'flags', '/apps/{appId}/flags', 'person'),
  flagsGet: r('GET', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsUpdate: r('PATCH', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsDelete: r('DELETE', 'flags', '/apps/{appId}/flags/{key}', 'person'),
  flagsKill: r('POST', 'flags', '/apps/{appId}/flags/{key}/kill', 'person'),
  flagsRestore: r('POST', 'flags', '/apps/{appId}/flags/{key}/restore', 'person'),
  segmentsList: r('GET', 'flags', '/apps/{appId}/segments', 'person'),

  // Roles and privileges, members and workspaces of the app (app-key routes).
  rolesList: r('GET', 'accounts', '/roles', 'app-key'),
  rolesCreate: r('POST', 'accounts', '/roles', 'app-key'),
  rolesUpdate: r('PATCH', 'accounts', '/roles/{roleId}', 'app-key'),
  rolesDelete: r('DELETE', 'accounts', '/roles/{roleId}', 'app-key'),
  privilegesList: r('GET', 'accounts', '/privileges', 'app-key'),
  privilegesCreate: r('POST', 'accounts', '/privileges', 'app-key'),
  privilegesUpdate: r('PATCH', 'accounts', '/privileges/{privilegeId}', 'app-key'),
  privilegesDelete: r('DELETE', 'accounts', '/privileges/{privilegeId}', 'app-key'),
  workspacesList: r('GET', 'accounts', '/workspaces', 'app-key'),
  membersList: r('GET', 'accounts', '/members', 'app-key', true),
  membersGet: r('GET', 'accounts', '/members/{memberId}', 'app-key', true),
  membersUpdate: r('PATCH', 'accounts', '/members/{memberId}', 'app-key', true),
  membersRemove: r('DELETE', 'accounts', '/members/{memberId}', 'app-key', true),
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof ROUTES;

/** The route as the API's contract writes it: `/v2/<microservice><path>`, with `{appId}` for an app. */
export function contractPath(route: Route): string {
  return `/v${String(API_VERSION)}/${route.service}${route.path.replace('{issuerApp}', '{appId}')}`;
}
