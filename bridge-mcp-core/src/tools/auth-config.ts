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
