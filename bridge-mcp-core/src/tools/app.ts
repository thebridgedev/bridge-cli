import { z } from 'zod';
import type { BridgeToolDefinition, ToolResult } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Read-only view of the Bridge app configuration. First tool through the
 * seam; description is written for an agent audience.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const getAppTool: BridgeToolDefinition<{}> = {
  name: 'get_app',
  description:
    'Read the full Bridge app configuration: name, URLs, enabled login methods, ' +
    'registered redirect URIs, default role, plan/billing setup and other app-level ' +
    'settings. Call this first to understand how the app is configured before ' +
    'changing anything or diagnosing auth issues.',
  inputSchema: {},
  handler: async (ctx) => {
    const data = await ctx.management.app.get();
    return { success: true, data };
  },
};

// ── Redirect-URI write tools (mirror `bridge app redirect-uris add/remove`,
//    TBP-546) ────────────────────────────────────────────────────────────────
//
// Read-modify-write: fetch the current list, add/remove ONE entry, write the
// whole list back. Never replaces the list wholesale — that is the regression
// these primitives exist to prevent.

/** Absolute-http(s) validation, identical to the CLI's validateRedirectUri. */
function invalidRedirectUri(value: string): ToolResult | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      success: false,
      error: {
        code: 'INVALID_REDIRECT_URI',
        message: `Invalid redirect URI: "${value}" is not an absolute URL (expected e.g. https://app.example.com/auth/oauth-callback).`,
        fix: 'Pass a full absolute URL including the scheme, host and path.',
      },
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      success: false,
      error: {
        code: 'INVALID_REDIRECT_URI',
        message: `Invalid redirect URI: "${value}" must use http or https.`,
        fix: 'Use an http:// or https:// URL.',
      },
    };
  }
  return null;
}

/**
 * Register one OAuth redirect URI, preserving the existing list.
 */
export const addRedirectUriTool: BridgeToolDefinition<{ url: z.ZodString }> = {
  name: 'add_redirect_uri',
  description:
    'Register ONE OAuth redirect (callback) URI on the Bridge app, preserving every ' +
    'already-registered URI — never replaces the list wholesale. The URL must be absolute ' +
    'http(s), e.g. https://app.example.com/auth/oauth-callback or http://localhost:5173/auth/' +
    'oauth-callback for local dev. Adding a URL that is already registered succeeds as a ' +
    'no-op (added: false). Use this when wiring a new environment or fixing a ' +
    '"redirect_uri mismatch" OAuth error; see get_environment_info for the currently ' +
    'registered list, and remove_redirect_uri to unregister one.',
  inputSchema: {
    url: z.string().min(1, 'url must be an absolute http(s) redirect URI.'),
  },
  handler: async (ctx, args) => {
    const url = args.url as string;
    const invalid = invalidRedirectUri(url);
    if (invalid) return invalid;
    try {
      const current = (await ctx.management.app.get()).redirectUris ?? [];
      if (current.includes(url)) {
        return {
          success: true,
          data: { added: false, message: `Already registered: ${url}`, redirectUris: current },
        };
      }
      const next = [...current, url];
      await ctx.management.app.update({ redirectUris: next });
      return { success: true, data: { added: true, redirectUris: next } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Unregister one OAuth redirect URI, preserving the rest of the list.
 */
export const removeRedirectUriTool: BridgeToolDefinition<{ url: z.ZodString }> = {
  name: 'remove_redirect_uri',
  description:
    'Unregister ONE OAuth redirect (callback) URI from the Bridge app, preserving every ' +
    'other registered URI. Fails with REDIRECT_URI_NOT_REGISTERED (listing the currently ' +
    'registered URIs) when the exact URL is not registered — the match is exact, including ' +
    'scheme, port and path. Use add_redirect_uri to register one.',
  inputSchema: {
    url: z.string().min(1, 'url must be the exact registered redirect URI to remove.'),
  },
  handler: async (ctx, args) => {
    const url = args.url as string;
    try {
      const current = (await ctx.management.app.get()).redirectUris ?? [];
      if (!current.includes(url)) {
        return {
          success: false,
          error: {
            code: 'REDIRECT_URI_NOT_REGISTERED',
            message: `Redirect URI not registered: ${url}. Registered URIs: ${
              current.length ? current.join(', ') : '(none)'
            }`,
            fix: 'Pass one of the registered URIs exactly (scheme, host, port and path must match).',
          },
        };
      }
      const next = current.filter((u) => u !== url);
      await ctx.management.app.update({ redirectUris: next });
      return { success: true, data: { removed: true, redirectUris: next } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
