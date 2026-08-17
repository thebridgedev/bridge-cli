/**
 * `bridge auth methods list|enable|disable` — TBP-547.
 *
 * One aggregated view over every login method the platform knows about
 * (password, magic link, passkeys, MFA, and the six social providers), plus
 * granular enable/disable toggles that map onto the matching app booleans.
 *
 * Facts this file encodes (verified against auth-core's management-types.ts
 * and the bridge-api app model):
 *  - Password login has NO disable switch anywhere in the platform — it is
 *    always enabled. `enable`/`disable password` is therefore a validation
 *    error, and the "refuse when zero login methods would remain" guardrail
 *    from the ticket is unreachable: password always counts as enabled, so
 *    the floor is one. What ships instead: disabling the last *toggleable*
 *    login method succeeds and the output notes that password is now the
 *    only enabled login method.
 *  - All six social booleans (google/azureAd/apple/github/facebook/linkedin)
 *    ARE on UpdateAppRequest, so every social provider is toggleable here.
 *  - `app.get()` exposes no credential-configured state for social providers,
 *    so enabling one always carries a warning pointing at `bridge setup sso`
 *    (or the dashboard for Apple, which `setup sso` does not cover).
 */
import type { Command } from 'commander';
import { getManagementClient } from '../../config.js';
import { outputSuccess, outputError } from '../../output.js';

type MethodKind = 'builtin' | 'social' | 'factor';

interface MethodSpec {
  method: string;
  kind: MethodKind;
  /** App boolean driving this method; null = no switch exists (password). */
  field:
    | 'magicLinkEnabled'
    | 'passkeysEnabled'
    | 'mfaEnabled'
    | 'googleSsoEnabled'
    | 'azureAdSsoEnabled'
    | 'appleSsoEnabled'
    | 'githubSsoEnabled'
    | 'facebookSsoEnabled'
    | 'linkedinSsoEnabled'
    | null;
  /** `bridge setup sso --provider <x>` name; null = not covered by setup sso. */
  ssoProvider: string | null;
  note?: string;
}

const METHOD_SPECS: MethodSpec[] = [
  {
    method: 'password',
    kind: 'builtin',
    field: null,
    ssoProvider: null,
    note: 'Always enabled — Bridge has no disable switch for password login',
  },
  { method: 'magicLink', kind: 'builtin', field: 'magicLinkEnabled', ssoProvider: null },
  { method: 'passkeys', kind: 'builtin', field: 'passkeysEnabled', ssoProvider: null },
  {
    method: 'mfa',
    kind: 'factor',
    field: 'mfaEnabled',
    ssoProvider: null,
    note: 'Second factor, not a standalone login method',
  },
  { method: 'google', kind: 'social', field: 'googleSsoEnabled', ssoProvider: 'google' },
  { method: 'azureAd', kind: 'social', field: 'azureAdSsoEnabled', ssoProvider: 'azure' },
  { method: 'apple', kind: 'social', field: 'appleSsoEnabled', ssoProvider: null },
  { method: 'github', kind: 'social', field: 'githubSsoEnabled', ssoProvider: 'github' },
  { method: 'facebook', kind: 'social', field: 'facebookSsoEnabled', ssoProvider: 'facebook' },
  { method: 'linkedin', kind: 'social', field: 'linkedinSsoEnabled', ssoProvider: 'linkedin' },
];

type ToggleField = NonNullable<MethodSpec['field']>;

const TOGGLEABLE_NAMES = METHOD_SPECS.filter((s) => s.field !== null).map((s) => s.method);

function togglePayload(field: ToggleField, enabled: boolean): Partial<Record<ToggleField, boolean>> {
  return { [field]: enabled } as Partial<Record<ToggleField, boolean>>;
}

function resolveToggleable(method: string): MethodSpec {
  const spec = METHOD_SPECS.find((s) => s.method === method);
  if (!spec) {
    throw new Error(
      `Unknown auth method: "${method}". Valid methods: ${TOGGLEABLE_NAMES.join(', ')} ` +
        '(password is always enabled and cannot be toggled).',
    );
  }
  if (spec.field === null) {
    throw new Error(
      'Password login is always enabled on Bridge — there is no disable switch, so it cannot ' +
        `be toggled. Toggleable methods: ${TOGGLEABLE_NAMES.join(', ')}.`,
    );
  }
  return spec;
}

function socialEnableWarning(spec: MethodSpec): string {
  if (spec.ssoProvider) {
    return (
      `Enabling ${spec.method} only flips the flag — it does not configure or verify provider ` +
      `credentials. If ${spec.method} is not set up yet, run: bridge setup sso --provider ${spec.ssoProvider}`
    );
  }
  return (
    `Enabling ${spec.method} only flips the flag — it does not configure or verify provider ` +
    `credentials. Configure ${spec.method} sign-in credentials in the Bridge dashboard ` +
    '(bridge setup sso does not cover this provider).'
  );
}

export function registerAuthMethodsCommands(auth: Command): void {
  const methods = auth
    .command('methods')
    .description('Aggregated login-method management: list, enable, disable');

  methods
    .command('list')
    .description('List every login method and whether it is enabled')
    .action(async () => {
      try {
        const app = (await getManagementClient().app.get()) as unknown as Record<string, unknown>;
        outputSuccess({
          methods: METHOD_SPECS.map((spec) => ({
            method: spec.method,
            enabled: spec.field === null ? true : app[spec.field] === true,
            kind: spec.kind,
            ...(spec.note !== undefined ? { note: spec.note } : {}),
          })),
        });
      } catch (err) {
        outputError(err);
      }
    });

  methods
    .command('enable <method>')
    .description(`Enable a login method (one of: ${TOGGLEABLE_NAMES.join(', ')})`)
    .action(async (method: string) => {
      try {
        const spec = resolveToggleable(method);
        await getManagementClient().app.update(togglePayload(spec.field as ToggleField, true));
        outputSuccess({
          method: spec.method,
          enabled: true,
          kind: spec.kind,
          ...(spec.kind === 'social' ? { warning: socialEnableWarning(spec) } : {}),
        });
      } catch (err) {
        outputError(err);
      }
    });

  methods
    .command('disable <method>')
    .description(`Disable a login method (one of: ${TOGGLEABLE_NAMES.join(', ')})`)
    .action(async (method: string) => {
      try {
        const spec = resolveToggleable(method);
        const client = getManagementClient();
        const app = (await client.app.get()) as unknown as Record<string, unknown>;
        await client.app.update(togglePayload(spec.field as ToggleField, false));

        // Guardrail (adjusted to reality): password has no disable switch, so
        // at least one login method is always enabled and a hard refusal can
        // never trigger. Instead, note when this disable leaves password as
        // the only enabled login method (factors like MFA don't count — they
        // are not standalone login methods).
        const otherLoginMethodsStillEnabled = METHOD_SPECS.some(
          (s) =>
            s.field !== null &&
            s.kind !== 'factor' &&
            s.method !== spec.method &&
            app[s.field] === true,
        );
        const leavesPasswordOnly = spec.kind !== 'factor' && !otherLoginMethodsStillEnabled;
        outputSuccess({
          method: spec.method,
          enabled: false,
          kind: spec.kind,
          ...(leavesPasswordOnly
            ? {
                note:
                  'Password is now the only enabled login method (password login is always ' +
                  'available on Bridge and cannot be disabled).',
              }
            : {}),
        });
      } catch (err) {
        outputError(err);
      }
    });
}
