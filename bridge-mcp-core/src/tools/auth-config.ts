import { z } from 'zod';
import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Login-focused projection of the app configuration: which login methods are
 * enabled and the token TTLs. Derived entirely from `management.app.get()`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const getAuthConfigTool: BridgeToolDefinition<{}> = {
  name: 'get_auth_config',
  description:
    'Read the Bridge app\'s login/auth configuration: which login methods are enabled ' +
    '(password — always available on Bridge, magic link, passkeys, MFA as a second ' +
    'factor, and each social provider: Google, LinkedIn, Azure AD, Apple, GitHub, ' +
    'Facebook) plus the access/refresh token TTLs as configured on the app. Use this ' +
    'when building or debugging login UI/flows — e.g. deciding which login buttons to ' +
    'render or why a provider button is missing. Narrower and login-focused compared ' +
    'to get_app, which returns the entire app object; for redirect URIs and env-var ' +
    'wiring use get_environment_info.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const app = await ctx.management.app.get();
      return {
        success: true,
        data: {
          loginMethods: {
            // Email + password login has no enable/disable switch on Bridge —
            // it is always available.
            password: { enabled: true, note: 'Always available on Bridge' },
            magicLink: { enabled: app.magicLinkEnabled },
            passkeys: { enabled: app.passkeysEnabled },
            mfa: { enabled: app.mfaEnabled, note: 'Second factor, not a standalone login method' },
            socialProviders: {
              google: { enabled: app.googleSsoEnabled },
              linkedin: { enabled: app.linkedinSsoEnabled },
              azureAd: { enabled: app.azureAdSsoEnabled },
              apple: { enabled: app.appleSsoEnabled },
              github: { enabled: app.githubSsoEnabled },
              facebook: { enabled: app.facebookSsoEnabled },
            },
          },
          tokens: {
            accessTokenTTL: app.accessTokenTTL,
            refreshTokenTTL: app.refreshTokenTTL,
          },
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

// ── Auth-method write tool (projection of `bridge app update`) ──────────────

/** Every login-method boolean on UpdateAppRequest (TBP-547 parity with the CLI). */
const AUTH_METHOD_TOGGLES = [
  'mfaEnabled',
  'passkeysEnabled',
  'magicLinkEnabled',
  'googleSsoEnabled',
  'linkedinSsoEnabled',
  'azureAdSsoEnabled',
  'appleSsoEnabled',
  'githubSsoEnabled',
  'facebookSsoEnabled',
] as const;

const SOCIAL_TOGGLES: ReadonlySet<string> = new Set([
  'googleSsoEnabled',
  'linkedinSsoEnabled',
  'azureAdSsoEnabled',
  'appleSsoEnabled',
  'githubSsoEnabled',
  'facebookSsoEnabled',
]);

/**
 * Toggle the app's login-method switches — every boolean that exists on the
 * app-update surface, including the six social provider flags (TBP-547 parity
 * with `bridge auth methods enable|disable`). Flipping a social flag does not
 * configure provider credentials; that stays setup_sso's job.
 */
export const updateAuthMethodsTool: BridgeToolDefinition<{
  mfaEnabled: z.ZodOptional<z.ZodBoolean>;
  passkeysEnabled: z.ZodOptional<z.ZodBoolean>;
  magicLinkEnabled: z.ZodOptional<z.ZodBoolean>;
  googleSsoEnabled: z.ZodOptional<z.ZodBoolean>;
  linkedinSsoEnabled: z.ZodOptional<z.ZodBoolean>;
  azureAdSsoEnabled: z.ZodOptional<z.ZodBoolean>;
  appleSsoEnabled: z.ZodOptional<z.ZodBoolean>;
  githubSsoEnabled: z.ZodOptional<z.ZodBoolean>;
  facebookSsoEnabled: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'update_auth_methods',
  description:
    "Toggle the app's login methods. Only the fields you pass are changed: mfaEnabled (MFA " +
    'as a second factor), passkeysEnabled (WebAuthn passkeys), magicLinkEnabled (email magic ' +
    'links), and the social provider flags (googleSsoEnabled, linkedinSsoEnabled, ' +
    'azureAdSsoEnabled, appleSsoEnabled, githubSsoEnabled, facebookSsoEnabled). Email + ' +
    'password login is always available on Bridge and has no toggle. IMPORTANT: enabling a ' +
    'social flag only flips the switch — it does NOT save provider credentials; to configure ' +
    'a provider end-to-end (credentials + enable + callback URL) use setup_sso instead. ' +
    'Returns the updated login-method configuration (same projection as get_auth_config).',
  inputSchema: {
    mfaEnabled: z.boolean().optional().describe('Enable MFA (second factor).'),
    passkeysEnabled: z.boolean().optional().describe('Enable WebAuthn passkeys.'),
    magicLinkEnabled: z.boolean().optional().describe('Enable email magic-link login.'),
    googleSsoEnabled: z.boolean().optional().describe('Enable Google SSO (flag only — credentials via setup_sso).'),
    linkedinSsoEnabled: z.boolean().optional().describe('Enable LinkedIn SSO (flag only — credentials via setup_sso).'),
    azureAdSsoEnabled: z.boolean().optional().describe('Enable Azure AD SSO (flag only — credentials via setup_sso, provider "azure").'),
    appleSsoEnabled: z.boolean().optional().describe('Enable Apple sign-in (flag only — credentials via the Bridge dashboard).'),
    githubSsoEnabled: z.boolean().optional().describe('Enable GitHub SSO (flag only — credentials via setup_sso).'),
    facebookSsoEnabled: z.boolean().optional().describe('Enable Facebook SSO (flag only — credentials via setup_sso).'),
  },
  handler: async (ctx, args) => {
    try {
      const data: Record<string, boolean> = {};
      for (const key of AUTH_METHOD_TOGGLES) {
        if (args[key] !== undefined) data[key] = args[key] as boolean;
      }
      if (Object.keys(data).length === 0) {
        return {
          success: false,
          error: {
            code: 'NO_FIELDS',
            message: 'No login-method toggles were provided; nothing to update.',
            fix: `Pass at least one of ${AUTH_METHOD_TOGGLES.join(', ')}.`,
          },
        };
      }
      const app = await ctx.management.app.update(data);
      const enabledSocial = Object.keys(data).filter((k) => SOCIAL_TOGGLES.has(k) && data[k]);
      return {
        success: true,
        data: {
          mfaEnabled: app.mfaEnabled,
          passkeysEnabled: app.passkeysEnabled,
          magicLinkEnabled: app.magicLinkEnabled,
          googleSsoEnabled: app.googleSsoEnabled,
          linkedinSsoEnabled: app.linkedinSsoEnabled,
          azureAdSsoEnabled: app.azureAdSsoEnabled,
          appleSsoEnabled: app.appleSsoEnabled,
          githubSsoEnabled: app.githubSsoEnabled,
          facebookSsoEnabled: app.facebookSsoEnabled,
          ...(enabledSocial.length > 0
            ? {
                warning:
                  `Enabling ${enabledSocial.join(', ')} only flips the flag — provider ` +
                  'credentials are not configured or verified here. Use setup_sso (or the ' +
                  'Bridge dashboard for Apple) if the provider is not set up yet.',
              }
            : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
