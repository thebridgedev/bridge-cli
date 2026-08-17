import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * The default Bridge platform API base URL, shared by the SDK plugins
 * (`initBridge({ apiBaseUrl })`) and the management client. The management
 * client does not expose which base URL it is currently configured against,
 * so we can only report the platform default plus how to override it.
 */
const BRIDGE_API_DEFAULT_BASE_URL = 'https://api.thebridge.dev';

interface EnvVarEntry {
  name: string;
  value?: string;
  note?: string;
}

/**
 * The practical wiring facts a coding agent needs to point a project at this
 * Bridge app. Env-var names are the canonical names read by the framework
 * plugins and taught by the CLI's integration guides (`bridge guide …`) and
 * the plugin READMEs — see the per-framework notes in the payload.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const getEnvironmentInfoTool: BridgeToolDefinition<{}> = {
  name: 'get_environment_info',
  description:
    'Read the practical wiring facts needed to configure a project against this Bridge ' +
    'app: the app id, Bridge API base URL, registered OAuth redirect URIs, default ' +
    'callback URI, allowed CORS origins, and the canonical env-var NAMES each framework ' +
    'reads (with suggested values where derivable). Use this when scaffolding a project, ' +
    'writing a .env file, or debugging a redirect/CORS mismatch. Env-var names are the ' +
    'ones documented by the Bridge framework plugins and CLI guides: Vite frontends use ' +
    'VITE_BRIDGE_*, Next.js uses NEXT_PUBLIC_BRIDGE_APP_ID, server SDKs use BRIDGE_APP_ID ' +
    '(+ BRIDGE_API_KEY where a management/API key is needed); bridge-angular has no ' +
    'env-var convention (configuration is code-based). The reported API base URL is the ' +
    'platform default — a self-hosted or staging Bridge deployment must override it. For ' +
    'login-method setup use get_auth_config; for the full app object use get_app.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const app = await ctx.management.app.get();

      const vite: EnvVarEntry[] = [
        { name: 'VITE_BRIDGE_APP_ID', value: app.id },
        {
          name: 'VITE_BRIDGE_API_BASE_URL',
          value: BRIDGE_API_DEFAULT_BASE_URL,
          note: 'Bridge API base URL; override when targeting a non-production Bridge deployment',
        },
        {
          name: 'VITE_BRIDGE_CALLBACK_URL',
          value: app.defaultCallbackUri,
          note: 'Must be one of the registered redirectUris',
        },
      ];

      const data = {
        appId: app.id,
        appName: app.name,
        bridgeApi: {
          defaultBaseUrl: BRIDGE_API_DEFAULT_BASE_URL,
          note:
            'Default base URL used by the Bridge SDK plugins and CLI. This tool cannot ' +
            'see which base URL its own client is configured against; if you run against ' +
            'a staging/self-hosted Bridge, use that URL instead.',
        },
        appUrls: {
          apiUrl: app.apiUrl,
          uiUrl: app.uiUrl,
          websiteUrl: app.websiteUrl,
        },
        oauth: {
          redirectUris: app.redirectUris ?? [],
          defaultCallbackUri: app.defaultCallbackUri,
          allowedOrigins: app.allowedOrigins ?? [],
        },
        envVars: {
          // bridge-svelte + bridge-react on Vite
          viteFrontends: vite,
          nextjs: [{ name: 'NEXT_PUBLIC_BRIDGE_APP_ID', value: app.id }] as EnvVarEntry[],
          // Legacy Create React App naming documented by bridge-react
          craReact: [
            { name: 'REACT_APP_BRIDGE_APP_ID', value: app.id },
            { name: 'REACT_APP_BRIDGE_CALLBACK_URL', value: app.defaultCallbackUri },
          ] as EnvVarEntry[],
          // bridge-nestjs / bridge-express
          serverSdks: [
            { name: 'BRIDGE_APP_ID', value: app.id },
            {
              name: 'BRIDGE_API_KEY',
              note: 'Secret management API key (create via `bridge token create`); never expose to a browser bundle',
            },
          ] as EnvVarEntry[],
          cli: [
            { name: 'BRIDGE_API_KEY', note: 'CI / service-account fallback when no `bridge auth login` credentials file exists' },
            { name: 'BRIDGE_BASE_URL', note: 'Overrides the Bridge API base URL for the CLI' },
            { name: 'BRIDGE_TENANT_ID', note: 'Default tenant context for tenant-scoped commands' },
          ] as EnvVarEntry[],
          angular: [] as EnvVarEntry[],
        },
        notes: [
          'bridge-angular has no env-var convention: configuration is passed in code (provider config), not read from the environment.',
          'Frontend env vars are build-time public values — never put BRIDGE_API_KEY in a frontend env file.',
        ],
      };
      return { success: true, data };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
