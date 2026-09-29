/**
 * Thin client for the bridge-api `/v1/cli/workspace/*` routes (TBP-769).
 *
 * One `bridge auth login` covers every app of the workspace (unless the user
 * chose "only this app" on the consent screen). These routes are how the CLI
 * lists those apps, creates one, and trades the login token for a short-lived
 * token for ANOTHER app — the same shape the MCP server's `app` argument uses.
 *
 * Every call authenticates with the LOGIN token (`x-api-key`); per-app tokens
 * are never accepted here, and are never written to disk by the CLI.
 *
 * Errors come back as `{ code, message, fix }`. They are surfaced as a
 * `WorkspaceApiError` whose `code` and `hint` (= the server's `fix`) are picked
 * up by `outputError`, so the reader gets the next step, not just the failure.
 */

export interface WorkspaceApp {
  id: string;
  name: string;
  home: boolean;
}

export interface WorkspaceAppsResponse {
  scope: 'workspace' | 'app';
  homeAppId: string;
  apps: WorkspaceApp[];
}

export interface WorkspaceAppToken {
  apiKey: string;
  expiresAt: string;
  app: { id: string; name: string };
}

export class WorkspaceApiError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly status: number;
  constructor(code: string, message: string, status: number, hint?: string) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.code = code;
    this.status = status;
    if (hint) this.hint = hint;
  }
}

export interface WorkspaceClientOptions {
  baseUrl: string;
  /** The `bridge auth login` token. */
  loginToken: string;
  fetchImpl?: typeof fetch;
}

export function createWorkspaceClient(options: WorkspaceClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/cli/workspace${path}`, {
        method,
        headers: {
          'x-api-key': options.loginToken,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new WorkspaceApiError(
        'NETWORK_ERROR',
        `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }
    if (!res.ok) throw await translateError(res);
    return (await res.json()) as T;
  }

  return {
    listApps: () => call<WorkspaceAppsResponse>('GET', '/apps'),
    appToken: (appId: string) =>
      call<WorkspaceAppToken>('POST', `/apps/${encodeURIComponent(appId)}/token`),
    createApp: (input: { name: string; callbackUrl?: string }) =>
      call<{ app: { id: string; name: string } }>('POST', '/apps', input),
  };
}

async function translateError(res: Response): Promise<WorkspaceApiError> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = undefined;
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

  let code = str(obj.code) ?? `HTTP_${res.status}`;
  let message = str(obj.message) ?? `Bridge API returned HTTP ${res.status}.`;
  let fix = str(obj.fix);

  if (res.status === 401) {
    code = str(obj.code) ?? 'UNAUTHORIZED';
    if (!str(obj.message)) message = 'Your login is no longer valid.';
    fix = fix ?? 'Run `bridge auth login` again.';
  } else if (res.status === 403 && !fix && !str(obj.code)) {
    // A token that is not a `bridge auth login` token (e.g. BRIDGE_API_KEY).
    fix = 'App selection needs a `bridge auth login` credential.';
  }
  return new WorkspaceApiError(code, message, res.status, fix);
}

/** App ids are Mongo ObjectIds. Anything else is treated as an app name. */
export function looksLikeAppId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value.trim());
}

/**
 * Resolve `<id|name>` against a list of apps. Id first (exact), then name
 * (case-insensitive). Two apps sharing a name is an ERROR, never a first match
 * — acting on the wrong app is the failure this whole area exists to prevent.
 */
export function resolveAppSelector<T extends { id: string; name: string }>(
  selector: string,
  apps: T[],
): T {
  const needle = selector.trim();
  const byId = apps.find((a) => a.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = apps.filter((a) => a.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new WorkspaceApiError(
      'APP_AMBIGUOUS',
      `"${needle}" matches ${byName.length} apps by name (${byName.map((a) => a.id).join(', ')}).`,
      0,
      'Select the app by id instead. `bridge app list` shows them.',
    );
  }
  throw new WorkspaceApiError(
    'APP_NOT_FOUND',
    `No app in this login matches "${needle}". Known: ${apps.map((a) => `${a.name} (${a.id})`).join(', ') || '(none)'}.`,
    0,
    'Run `bridge app list` to see the apps this login covers.',
  );
}
