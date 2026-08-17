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

/**
 * Toggle the app's login-method switches. Only the three toggles that exist on
 * the app-update surface today; social providers are enabled via setup_sso.
 */
export const updateAuthMethodsTool: BridgeToolDefinition<{
  mfaEnabled: z.ZodOptional<z.ZodBoolean>;
  passkeysEnabled: z.ZodOptional<z.ZodBoolean>;
  magicLinkEnabled: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'update_auth_methods',
  description:
    "Toggle the app's login methods. Only the fields you pass are changed: mfaEnabled (MFA " +
    'as a second factor), passkeysEnabled (WebAuthn passkeys), magicLinkEnabled (email magic ' +
    'links). Email + password login is always available on Bridge and has no toggle. Social ' +
    'login providers (Google, GitHub, Azure, …) are NOT toggled here — enabling one requires ' +
    'provider credentials, so use setup_sso instead. Returns the updated login-method ' +
    'configuration (same projection as get_auth_config).',
  inputSchema: {
    mfaEnabled: z.boolean().optional().describe('Enable MFA (second factor).'),
    passkeysEnabled: z.boolean().optional().describe('Enable WebAuthn passkeys.'),
    magicLinkEnabled: z.boolean().optional().describe('Enable email magic-link login.'),
  },
  handler: async (ctx, args) => {
    try {
      const data: { mfaEnabled?: boolean; passkeysEnabled?: boolean; magicLinkEnabled?: boolean } =
        {};
      if (args.mfaEnabled !== undefined) data.mfaEnabled = args.mfaEnabled as boolean;
      if (args.passkeysEnabled !== undefined) data.passkeysEnabled = args.passkeysEnabled as boolean;
      if (args.magicLinkEnabled !== undefined) data.magicLinkEnabled = args.magicLinkEnabled as boolean;
      if (Object.keys(data).length === 0) {
        return {
          success: false,
          error: {
            code: 'NO_FIELDS',
            message: 'No login-method toggles were provided; nothing to update.',
            fix: 'Pass at least one of mfaEnabled, passkeysEnabled, magicLinkEnabled.',
          },
        };
      }
      const app = await ctx.management.app.update(data);
      return {
        success: true,
        data: {
          mfaEnabled: app.mfaEnabled,
          passkeysEnabled: app.passkeysEnabled,
          magicLinkEnabled: app.magicLinkEnabled,
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
