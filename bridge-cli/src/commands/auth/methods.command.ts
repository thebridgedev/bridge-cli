/**
 * `bridge auth methods list|enable|disable <method>` — TBP-547.
 *
 * One view of every login method and one verb to switch any of them.
 *
 *  - `list` prints the same `loginMethods` object as the MCP tool
 *    get_auth_config, from the same `app.get()` that `bridge auth config` and
 *    `bridge info auth-config` read, so the three never disagree.
 *  - `enable` / `disable` flip the one app switch behind the method. Social
 *    providers keep their saved credentials when switched off, so switching
 *    them back on needs no new setup.
 *  - Bridge itself refuses a social provider with no credentials yet
 *    (SIGN_IN_CREDENTIALS_MISSING) and the last remaining sign-in method
 *    (LAST_SIGN_IN_METHOD); its code and fix come through as the error.
 *  - Password has no switch on Bridge: it is listed as always available, and
 *    enabling or disabling it is refused here with that reason.
 */
import type { Command } from 'commander';
import { getManagementClient } from '../../config.js';
import { outputSuccess, outputError } from '../../output.js';

type AppSwitch =
  | 'magicLinkEnabled'
  | 'passkeysEnabled'
  | 'mfaEnabled'
  | 'googleSsoEnabled'
  | 'linkedinSsoEnabled'
  | 'azureAdSsoEnabled'
  | 'appleSsoEnabled'
  | 'githubSsoEnabled'
  | 'facebookSsoEnabled';

/** Method name → the app switch behind it. Names match get_auth_config. */
export const METHOD_SWITCHES: Readonly<Record<string, AppSwitch>> = {
  magicLink: 'magicLinkEnabled',
  passkeys: 'passkeysEnabled',
  mfa: 'mfaEnabled',
  google: 'googleSsoEnabled',
  linkedin: 'linkedinSsoEnabled',
  azureAd: 'azureAdSsoEnabled',
  apple: 'appleSsoEnabled',
  github: 'githubSsoEnabled',
  facebook: 'facebookSsoEnabled',
};

export const METHOD_NAMES = ['password', ...Object.keys(METHOD_SWITCHES)];

type AppLike = Partial<Record<AppSwitch, boolean>>;

/** The `loginMethods` object get_auth_config returns — kept identical on purpose. */
export function loginMethods(app: AppLike) {
  return {
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
  };
}

class AuthMethodError extends Error {
  constructor(message: string, readonly code: string, readonly hint: string) {
    super(message);
  }
}

/** Accepts the canonical name in any case, and kebab/snake forms (magic-link). */
export function resolveMethod(input: string): { method: string; field: AppSwitch } {
  const wanted = input.replace(/[-_\s]/g, '').toLowerCase();
  const method = METHOD_NAMES.find((m) => m.toLowerCase() === wanted);
  if (method === 'password') {
    throw new AuthMethodError(
      'Password sign-in has no switch on Bridge: it is always available, so it cannot be enabled or disabled.',
      'PASSWORD_ALWAYS_ON',
      `To change how people sign in, switch one of these instead: ${Object.keys(METHOD_SWITCHES).join(', ')}.`,
    );
  }
  if (!method) {
    throw new AuthMethodError(
      `Unknown login method "${input}".`,
      'UNKNOWN_AUTH_METHOD',
      `Use one of: ${Object.keys(METHOD_SWITCHES).join(', ')}. \`bridge auth methods list\` shows them all.`,
    );
  }
  return { method, field: METHOD_SWITCHES[method] };
}

async function setMethod(input: string, enabled: boolean): Promise<void> {
  try {
    const { method, field } = resolveMethod(input);
    const app = (await getManagementClient().app.update({ [field]: enabled } as never)) as unknown as AppLike;
    outputSuccess({ method, enabled: app[field] === true, loginMethods: loginMethods(app) });
  } catch (err) {
    outputError(err);
  }
}

export function registerAuthMethodsCommands(auth: Command): void {
  const methods = auth
    .command('methods')
    .description('Every login method in one place: list them, switch one on or off');

  methods
    .command('list')
    .description('List every login method and whether it is on (same as the MCP tool get_auth_config)')
    .action(async () => {
      try {
        const app = (await getManagementClient().app.get()) as unknown as AppLike;
        outputSuccess({ loginMethods: loginMethods(app) });
      } catch (err) {
        outputError(err);
      }
    });

  methods
    .command('enable <method>')
    .description(
      `Switch a login method on (${Object.keys(METHOD_SWITCHES).join(', ')}). ` +
        'A social provider needs its credentials first: bridge setup sso --provider <p>',
    )
    .action((method: string) => setMethod(method, true));

  methods
    .command('disable <method>')
    .description(
      'Switch a login method off. A social provider keeps its credentials, so enable switches it back on. ' +
        'Bridge refuses to switch off the last remaining sign-in method.',
    )
    .action((method: string) => setMethod(method, false));
}
