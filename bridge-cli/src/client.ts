import type { Sessions } from './auth/session.js';
import type { Discovery } from './core/discovery.js';
import { CliError } from './core/errors.js';
import { call, type Fetch, type HttpResponse } from './core/http.js';
import { ROUTES, type RouteName } from './core/routes.js';
import { fillPath } from './core/urls.js';

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface KeyCallOptions extends CallOptions {
  /** For routes that act in one workspace of the app. */
  readonly workspace?: string;
}

/**
 * Calls Bridge's version 2 API for the signed-in developer. Every call is a
 * named route from {@link ROUTES}; its address is the microservice's base
 * from the issuer's metadata plus the route's path.
 */
export class BridgeClient {
  constructor(
    readonly discovery: Discovery,
    private readonly fetchFn: Fetch,
    readonly sessions: Sessions,
  ) {}

  url(name: RouteName, params: Readonly<Record<string, string>> = {}, query: Readonly<Record<string, string | undefined>> = {}): string {
    const route = ROUTES[name];
    const url = new URL(this.discovery.bases[route.service] + fillPath(route.path, { issuerApp: this.discovery.appId, ...params }));
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  /** A call with the developer's token. Renewed first when it is about to expire, and once more if Bridge refuses it. */
  async person<T = unknown>(name: RouteName, options: CallOptions = {}): Promise<HttpResponse<T>> {
    const route = ROUTES[name];
    if (route.auth !== 'person') throw new Error(`${name} does not take the developer's token.`);
    const send = (token: string) =>
      call<T>(this.fetchFn, {
        method: route.method,
        url: this.url(name, options.params, options.query),
        headers: { ...options.headers, authorization: `Bearer ${token}` },
        body: options.body,
      });
    try {
      return await send(await this.sessions.accessToken(this.discovery));
    } catch (error) {
      if (!(error instanceof CliError) || error.status !== 401 || error.kind === 'reauthenticate') throw error;
      return send(await this.sessions.accessToken(this.discovery, { force: true }));
    }
  }

  /** A call with an app key, for the routes version 2 offers only to the app's own server. */
  async withKey<T = unknown>(name: RouteName, key: string, options: KeyCallOptions = {}): Promise<HttpResponse<T>> {
    const route = ROUTES[name];
    if (route.auth !== 'app-key') throw new Error(`${name} does not take an app key.`);
    if ('workspace' in route && options.workspace === undefined) {
      throw new CliError('invalid', 'Name the workspace with --workspace <id> (`bridge workspace list` shows them).');
    }
    return call<T>(this.fetchFn, {
      method: route.method,
      url: this.url(name, options.params, options.query),
      headers: {
        ...options.headers,
        'x-api-key': key,
        ...(options.workspace === undefined ? {} : { 'bridge-workspace': options.workspace }),
      },
      body: options.body,
    });
  }
}
