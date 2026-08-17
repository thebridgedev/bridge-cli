import { z } from 'zod';
import type { SetupSSOParams } from '@nebulr-group/bridge-auth-core';
import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * SSO setup workflow tool — mirrors `bridge setup sso`. Thick operation via
 * auth-core's ManagementWorkflows: saves the provider credentials, flips the
 * provider's enable switch, and returns the app's callback URL.
 */
export const setupSsoTool: BridgeToolDefinition<{
  provider: z.ZodEnum<['google', 'azure', 'github', 'linkedin', 'facebook', 'saml', 'oidc']>;
  clientId: z.ZodOptional<z.ZodString>;
  clientSecret: z.ZodOptional<z.ZodString>;
  metadataUrl: z.ZodOptional<z.ZodString>;
  discoveryUrl: z.ZodOptional<z.ZodString>;
}> = {
  name: 'setup_sso',
  description:
    'Enable a social/enterprise SSO login provider on the Bridge app in one step: saves the ' +
    "provider credentials, turns the provider on, and returns the app's OAuth callback URL. " +
    'Arguments: provider (google | azure | github | linkedin | facebook | saml | oidc), plus ' +
    'the provider credentials — clientId + clientSecret for OAuth providers, metadataUrl for ' +
    'saml, discoveryUrl for oidc. THE ACTIONABLE OUTPUT IS THE RETURNED callbackUrl: the user ' +
    "must register it in the provider's console (e.g. Google Cloud OAuth credentials, GitHub " +
    'OAuth app settings) or logins will fail with a redirect mismatch — always surface the ' +
    'callbackUrl and that instruction to the user. This is the ONLY way to enable social ' +
    'providers; update_auth_methods only covers MFA/passkeys/magic-link toggles.',
  inputSchema: {
    provider: z.enum(['google', 'azure', 'github', 'linkedin', 'facebook', 'saml', 'oidc']),
    clientId: z.string().min(1).optional().describe('OAuth client ID from the provider.'),
    clientSecret: z.string().min(1).optional().describe('OAuth client secret from the provider.'),
    metadataUrl: z.string().min(1).optional().describe('SAML metadata URL (saml provider only).'),
    discoveryUrl: z.string().min(1).optional().describe('OIDC discovery URL (oidc provider only).'),
  },
  handler: async (ctx, args) => {
    try {
      const result = await ctx.management.workflows.setupSSO({
        provider: args.provider as SetupSSOParams['provider'],
        config: {
          clientId: args.clientId as string | undefined,
          clientSecret: args.clientSecret as string | undefined,
          metadataUrl: args.metadataUrl as string | undefined,
          discoveryUrl: args.discoveryUrl as string | undefined,
        },
      });
      return { success: true, data: result };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
