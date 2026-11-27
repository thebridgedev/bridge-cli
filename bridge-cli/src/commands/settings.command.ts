import { InvalidArgumentError, type Command } from 'commander';
import { branding, listEvents, sender, signInSettings, userPasskeys, userSecondStep, type BrandingFields, type MfaDryRun, type MfaSettings, type SecondStepMethod, type SignInSettings, type SignInSettingsFields } from '../api/settings.js';
import { apps } from '../api/apps.js';
import { connection, plans } from '../api/billing.js';
import { CliError } from '../core/errors.js';
import { action, type Context, type Deps } from './context.js';
import { findWorkspaceId } from './workspace-id.js';

/**
 * The commands that read and change how the app looks and signs people in, and what happened in it: `branding`,
 * `auth methods|config|password-policy`, `event list` and `setup communication` (the 0.x commands of those names, on
 * version 2), with `auth providers`, `auth token-lifetime`, `auth email-confirmation`, `auth mfa`, `user passkeys` and
 * `user mfa-reset`. What
 * the new Bridge does not have yet (Apple, a free-form stylesheet) is said, never faked.
 */

const FONTS = ['system', 'inter', 'roboto', 'open-sans', 'montserrat', 'nunito', 'lora'];
const RADII = ['none', 'small', 'medium', 'large'];

/** The brightness of a #rrggbb colour, 0 to 1, to tell a light page from a dark one. */
function brightness(hex: string): number {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (value === undefined) return 1;
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function fontOf(family: string): string {
  const first = (family.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase().replace(/\s+/g, '-');
  if (FONTS.includes(first)) return first;
  if (['sans-serif', 'serif', 'system-ui', 'ui-sans-serif'].includes(first)) return 'system';
  throw new InvalidArgumentError(`"${family}" is not one of the fonts the sign-in page hosts: ${FONTS.join(', ')}.`);
}

function radiusOf(value: string): string {
  const word = value.trim().toLowerCase();
  if (RADII.includes(word)) return word;
  const pixels = /^(\d+(?:\.\d+)?)\s*(?:px)?$/.exec(word)?.[1];
  if (pixels === undefined) throw new InvalidArgumentError(`"${value}" is not a size the sign-in page takes: ${RADII.join(', ')}, or a size in px.`);
  const px = Number(pixels);
  return px === 0 ? 'none' : px <= 6 ? 'small' : px <= 12 ? 'medium' : 'large';
}

/** The login methods, as `bridge auth methods list` shows them: what is on, and what Bridge does not offer yet. */
const NOT_YET = { enabled: false, note: 'Not available on Bridge yet' } as const;

/**
 * The social providers: the CLI's names, Identity and Access's key (`azure` stays the API name for
 * Microsoft, which callers rely on), the key the 0.x output used, and the name people read.
 */
const PROVIDERS = [
  { cli: 'google', key: 'google', view: 'google', name: 'Google' },
  { cli: 'linkedin', key: 'linkedin', view: 'linkedin', name: 'LinkedIn' },
  { cli: 'microsoft', key: 'azure', view: 'microsoft', name: 'Microsoft' },
  { cli: 'github', key: 'github', view: 'github', name: 'GitHub' },
  { cli: 'facebook', key: 'facebook', view: 'facebook', name: 'Facebook' },
] as const;
/** A provider by the name a developer types: `microsoft` (also `azure`, `azuread`), `google`, … */
function providerOf(input: string) {
  const wanted = input.replace(/[-_\s]/g, '').toLowerCase();
  return PROVIDERS.find((each) => each.cli === wanted || each.key === wanted || (each.key === 'azure' && wanted === 'azuread')) ?? null;
}

/** Who can sign in with Microsoft, as the CLI names it, and the tenant Identity and Access keeps. */
const WHO = { any: 'common', work: 'organizations', personal: 'consumers' } as const;

/** One provider's state: on or off, its credentials saved or not, the return address to register, and Microsoft's facts. */
function providerState(settings: SignInSettings, provider: (typeof PROVIDERS)[number]) {
  const saved = settings.providers?.[provider.key];
  return {
    name: provider.name,
    enabled: settings.social?.[provider.key] === true,
    credentialsSaved: saved?.configured === true,
    ...(saved?.clientId == null ? {} : { clientId: saved.clientId }),
    ...(saved?.returnAddress === undefined ? {} : { returnAddress: saved.returnAddress }),
    ...(provider.key === 'azure' && saved?.configured === true
      ? { whoCanSignIn: saved.audience ?? 'any', ...(saved.audience === 'directory' ? { directory: saved.tenantId ?? null } : {}), secretExpiresAt: saved.secretExpiresAt ?? null, secretExpiry: saved.secretExpiry ?? null }
      : {}),
  };
}

function loginMethods(settings: SignInSettings) {
  return {
    password: { enabled: settings.methods.password },
    magicLink: { enabled: settings.methods.magicLink },
    passkeys: { enabled: settings.methods.passkeys },
    mfa: mfaView(settings),
    socialProviders: { ...Object.fromEntries(PROVIDERS.map((each) => [each.view, providerState(settings, each)])), apple: NOT_YET },
  };
}

/** The ways of the second step as the CLI names them, and Identity and Access's keys. */
const SECOND_STEP: Readonly<Record<string, SecondStepMethod>> = { totp: 'totp', authenticator: 'totp', app: 'totp', email: 'email', sms: 'sms', text: 'sms', texts: 'sms' };
const STRONGEST_NOTE = 'An authenticator app is the strongest choice.';
const TEXTS_NEED_PLAN = 'Text messages need a plan that includes texts. Nothing was changed.';

/** MFA as the CLI shows it: on or off, where it is required, the ways allowed, the remembered device. */
function mfaView(settings: SignInSettings) {
  const mfa = settings.mfa;
  if (mfa === undefined) return { enabled: settings.secondStep === true, note: 'Second factor, not a standalone login method: a code by text message after any way of signing in' };
  return {
    enabled: settings.secondStep === true,
    requiredIn: mfa.requiredIn === 'all' ? 'all' : 'workspaces',
    methods: (Object.keys(mfa.methods) as SecondStepMethod[]).filter((method) => mfa.methods[method]),
    rememberDeviceDays: mfa.rememberDeviceDays,
    note: `Second factor, not a standalone login method: asked after any way of signing in, ${mfa.requiredIn === 'all' ? 'in every workspace' : 'in workspaces that turned MFA on'}. ${STRONGEST_NOTE}`,
  };
}

/** `--methods totp,email` as the whole set of ways: each one named on, the others off. */
export function methodsOf(list: string): Record<SecondStepMethod, boolean> {
  const chosen = list.split(',').map((each) => each.trim().toLowerCase()).filter((each) => each !== '' && each !== 'none');
  const methods: Record<SecondStepMethod, boolean> = { totp: false, email: false, sms: false };
  for (const name of chosen) {
    const method = SECOND_STEP[name];
    if (method === undefined) throw new CliError('invalid', `"${name}" is not a way of the second step. Nothing was changed.`, { hint: 'Use totp (authenticator app), email or sms, comma-separated: --methods totp,email' });
    methods[method] = true;
  }
  return methods;
}

/** The dry run as the CLI prints it: the counts, and the users each group names (ids, at most 50). */
function dryRunView(result: MfaDryRun) {
  return {
    total: result.total,
    mfaOn: result.mfaOn,
    alreadySetUp: result.ready.count,
    getEmailCode: result.emailCode.count,
    setUpAtNextSignIn: result.setUp.count,
    notSignedUpYet: result.notSignedUp,
    lockedOut: result.lockedOut.count,
    lockedOutUsers: result.lockedOut.users,
  };
}

/** A refusal of switching texts on (the texts gate, 403): said as the plan it needs. */
function textsRefused(error: unknown, smsOn: boolean): never {
  if (smsOn && error instanceof CliError && error.status === 403) throw new CliError('plan-required', TEXTS_NEED_PLAN, { status: 403, hint: 'Choose totp (an authenticator app) or email instead, or change the plan to one that includes texts.' });
  throw error;
}

/** The method names `auth methods enable|disable` takes, in any case, with kebab or snake forms (`magic-link`). */
const SWITCHES = { magiclink: 'magicLink', passkeys: 'passkeys', password: 'password' } as const;
const NOT_AVAILABLE = ['apple'];

/** `--since` as a time: a duration back from now (24h, 7d, 2w) or an ISO date. */
export function sinceOf(since: string, now: number): string {
  const relative = /^(\d{1,6})\s*([smhdw])$/i.exec(since.trim());
  const unit: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  if (relative !== null) return new Date(now - Number(relative[1]) * (unit[(relative[2] as string).toLowerCase()] as number)).toISOString();
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) throw new CliError('invalid', `--since "${since}" is neither a duration nor a date.`, { hint: 'Give a duration like 24h or 7d, or an ISO date like 2026-11-01.' });
  return at.toISOString();
}

async function methodSwitch(ctx: Context, input: string, on: boolean): Promise<void> {
  const wanted = input.replace(/[-_\s]/g, '').toLowerCase();
  if (NOT_AVAILABLE.includes(wanted)) {
    throw new CliError('not-offered', `${input}: not available on Bridge yet.`, { hint: 'Password, magic links and passkeys are. Nothing was changed.' });
  }
  // MFA is the app's second-step switch: `bridge auth mfa set` chooses where and which ways.
  if (wanted === 'mfa' || wanted === 'secondstep' || wanted === '2fa') {
    const { c, appId } = await ctx.forApp();
    const settings = await signInSettings.update(c, appId, { secondStep: on });
    return ctx.io.result({ method: 'mfa', enabled: settings.secondStep === true, loginMethods: loginMethods(settings) });
  }
  const provider = providerOf(input);
  if (provider !== null) {
    const { c, appId } = await ctx.forApp();
    if (on && (await signInSettings.get(c, appId)).providers?.[provider.key]?.configured !== true) {
      throw new CliError('invalid', `${provider.name}'s client ID and secret are not saved yet. Nothing was changed.`, { hint: `Save them first: bridge auth providers set ${provider.cli} --client-id <id> --client-secret <secret>${provider.key === 'azure' ? ' [--who-can-sign-in any|work|personal|directory]' : ''} --enable` });
    }
    const settings = await signInSettings.update(c, appId, { social: { [provider.key]: on } });
    return ctx.io.result({ method: provider.cli, enabled: settings.social?.[provider.key] === true, loginMethods: loginMethods(settings) });
  }
  const field = (SWITCHES as Record<string, string | undefined>)[wanted];
  if (field === undefined) throw new CliError('invalid', `Unknown login method "${input}".`, { hint: `Use one of: magicLink, passkeys, password, ${PROVIDERS.map((each) => each.cli).join(', ')}. \`bridge auth methods list\` shows them all.` });
  const { c, appId } = await ctx.forApp();
  const settings = await signInSettings.update(c, appId, { methods: { [field]: on } });
  ctx.io.result({ method: field, enabled: (settings.methods as Record<string, boolean>)[field] === true, loginMethods: loginMethods(settings) });
}

/** The password presets. */
const PRESETS = ['basic', 'recommended', 'strict', 'compliance', 'custom'];
const RULES = [
  ['requireUpper', '--require-upper', 'needs an upper-case letter'],
  ['requireLower', '--require-lower', 'needs a lower-case letter'],
  ['requireDigit', '--require-digit', 'needs a number'],
  ['requireSymbol', '--require-symbol', 'needs a symbol'],
  ['blockEmail', '--block-email', "refuses a password holding the person's email address"],
  ['blockCommon', '--block-common', 'refuses common passwords (Bridge\'s list, refreshed every release)'],
  ['blockAppName', '--block-app-name', "refuses a password holding the app's name"],
] as const;
const yesNo = (value: string): boolean => {
  if (value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === 'no' || value === 'off') return false;
  throw new InvalidArgumentError('true or false');
};

/** What the password rules are, as the CLI shows them: the rules, the badge and the common-password list's date. */
function passwordView(settings: SignInSettings) {
  const facts = settings.passwordFacts;
  const badge = facts?.badge === 'nist' ? 'Follows NIST password guidelines (SP 800-63B)' : facts?.badge === 'audit' ? 'Meets common audit checklists' : null;
  return {
    passwordRules: settings.password,
    ...(badge === null ? {} : { badge }),
    ...(facts?.commonPasswords?.updated === undefined ? {} : { commonPasswordList: `updated ${facts.commonPasswords.updated}` }),
    ...(facts?.productionFloor === undefined ? {} : { productionFloor: facts.productionFloor.kept === true ? `${String(facts.productionFloor.preset)} (kept from before the move)` : 'recommended' }),
    ...(settings.passwordExpiryDays === undefined ? {} : { passwordExpiryDays: settings.passwordExpiryDays, passwordHistory: settings.passwordHistory ?? 0 }),
    ...(settings.passwordExpiryDays != null && facts?.aging?.warning !== undefined ? { warning: facts.aging.warning } : {}),
  };
}

/** The presets that take password expiry and history. */
const AGING_PRESETS = ['compliance', 'custom'];
const EXPIRY_DAYS = [30, 60, 90, 180, 365];

/** `--expiry-days off|30|60|90|180|365`: days, or null for never. */
function expiryOf(value: string): number | null {
  const word = value.trim().toLowerCase();
  if (word === 'off' || word === 'never' || word === '0') return null;
  const days = Number(word);
  if (!EXPIRY_DAYS.includes(days)) throw new InvalidArgumentError(`off or one of ${EXPIRY_DAYS.join(', ')}`);
  return days;
}

/** `--history off|0..24`: how many old passwords are refused. */
function historyOf(value: string): number {
  const word = value.trim().toLowerCase();
  if (word === 'off') return 0;
  const depth = Number(word);
  if (!Number.isInteger(depth) || depth < 0 || depth > 24) throw new InvalidArgumentError('off, or 0 to 24');
  return depth;
}

const tokensView = (settings: SignInSettings) => ({ accessTokenTTL: settings.lifetimes.accessTokenSeconds, refreshTokenTTL: settings.lifetimes.sessionAbsoluteSeconds, sessionIdleTTL: settings.lifetimes.sessionIdleSeconds });

/** The lifetimes a change sets, within Identity and Access's bounds (shared by `token-lifetime` and the moved flags). */
function lifetimesOf(current: SignInSettings, opts: { accessTokenTtl?: number; refreshTokenTtl?: number; sessionIdleTtl?: number }): Record<string, number> {
  const lifetimes: Record<string, number> = {};
  for (const [flag, name, value] of [['--access-token-ttl', 'accessTokenSeconds', opts.accessTokenTtl], ['--refresh-token-ttl', 'sessionAbsoluteSeconds', opts.refreshTokenTtl], ['--session-idle-ttl', 'sessionIdleSeconds', opts.sessionIdleTtl]] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) throw new CliError('invalid', `${flag} is a whole number of seconds. Nothing was changed.`);
    const range = current.bounds?.lifetimes?.[name];
    if (range !== undefined && (value < range.min || value > range.max)) throw new CliError('invalid', `${flag} is ${String(range.min)} to ${String(range.max)} seconds on Bridge. Nothing was changed.`);
    lifetimes[name] = value;
  }
  // A session's idle time never outlives its whole life: a shorter life shortens the idle time with it.
  if (opts.refreshTokenTtl !== undefined && opts.sessionIdleTtl === undefined && current.lifetimes.sessionIdleSeconds > opts.refreshTokenTtl) lifetimes['sessionIdleSeconds'] = opts.refreshTokenTtl;
  return lifetimes;
}

/** A refusal of the password rules (production's floor): said as Bridge said it, with what to do. */
function rulesRefused(error: unknown): never {
  if (error instanceof CliError && /expiry and history/i.test(error.message)) throw new CliError('invalid', `${error.message} Nothing was changed.`, { hint: 'Use --preset compliance or custom, or turn them off with --expiry-days off --history off.' });
  if (error instanceof CliError && /password rules/i.test(error.message)) throw new CliError('invalid', `${error.message} Nothing was changed.`, { hint: 'Pick recommended or strict, or switch the app to development first (bridge app mode development --yes).' });
  throw error;
}

export function registerSettingsCommands(program: Command, deps: Deps): void {
  const brand = program.command('branding').description("The look of the app's hosted sign-in page: a scheme, colours, a radius and a font from fixed lists, never free-form CSS");
  brand.command('get').description('The current branding').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result((await branding.get(c, appId)).body);
    }),
  );
  brand
    .command('update')
    .description('Change the branding; only what you pass changes')
    .option('--bg-color <color>', 'Page background (#rrggbb); the scheme follows its brightness unless --scheme is given')
    .option('--text-color <color>', 'Text colour (#rrggbb)')
    .option('--primary-btn-bg <color>', 'Button and link colour (#rrggbb)')
    .option('--link-color <color>', 'Link colour: used as the primary colour when --primary-btn-bg is not given')
    .option('--primary-btn-text <color>', 'Accepted, not applied: the page picks the button label colour for contrast')
    .option('--font-family <font>', `A font the page hosts: ${FONTS.join(', ')}`)
    .option('--border-radius <radius>', `${RADII.join(' | ')}, or a size in px`)
    .option('--scheme <scheme>', 'light | dark | auto')
    .action(
      action(deps, async (ctx, opts: { bgColor?: string; textColor?: string; primaryBtnBg?: string; linkColor?: string; primaryBtnText?: string; fontFamily?: string; borderRadius?: string; scheme?: string }) => {
        const colors: Record<string, string> = {};
        if (opts.bgColor !== undefined) colors['background'] = opts.bgColor;
        if (opts.textColor !== undefined) colors['text'] = opts.textColor;
        const primary = opts.primaryBtnBg ?? opts.linkColor;
        if (primary !== undefined) colors['primary'] = primary;
        const notApplied = [...(opts.primaryBtnText === undefined ? [] : ['--primary-btn-text']), ...(opts.linkColor !== undefined && opts.primaryBtnBg !== undefined ? ['--link-color'] : [])];
        const { c, appId } = await ctx.forApp();
        const read = await branding.get(c, appId);
        const current = read.body;
        const body: BrandingFields = {};
        if (Object.keys(colors).length > 0) {
          body.colors = colors;
          const background = colors['background'] ?? current.colors['background'];
          body.scheme = opts.scheme ?? (colors['background'] !== undefined ? (brightness(colors['background']) >= 0.5 ? 'light' : 'dark') : current.scheme !== 'auto' ? current.scheme : background === undefined ? 'light' : brightness(background) >= 0.5 ? 'light' : 'dark');
        } else if (opts.scheme !== undefined) body.scheme = opts.scheme;
        if (opts.fontFamily !== undefined) body.font = fontOf(opts.fontFamily);
        if (opts.borderRadius !== undefined) body.radius = radiusOf(opts.borderRadius);
        if (Object.keys(body).length === 0) {
          throw new CliError('invalid', 'Nothing to change that the sign-in page takes.', { hint: 'It takes --bg-color, --text-color, --primary-btn-bg (also --link-color when it is alone), --font-family, --border-radius and --scheme. Its button label colour is chosen for contrast, and there is no free-form CSS.' });
        }
        const changed = await branding.save(c, appId, body, read.headers.get('etag'));
        if (notApplied.length > 0) ctx.io.info(`Not applied: ${notApplied.join(', ')}. The sign-in page keeps one primary colour for buttons and links, and chooses the button label colour itself for contrast.`);
        ctx.io.result({ branding: changed, ...(notApplied.length === 0 ? {} : { notApplied }) });
      }),
    );

  const auth = program.commands.find((each) => each.name() === 'auth') as Command;
  const methods = auth.command('methods').description('Every login method in one place: list them, switch one on or off');
  methods.command('list').description('The login methods and whether each is on').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result({ loginMethods: loginMethods(await signInSettings.get(c, appId)) });
    }),
  );
  methods.command('enable <method>').description('Switch a login method on: magicLink, passkeys, password, or a social provider whose credentials are saved (google, linkedin, microsoft, github, facebook)').action(action(deps, (ctx, method: string) => methodSwitch(ctx, method, true)));
  methods.command('disable <method>').description('Switch a login method off. Bridge refuses to switch off the last one').action(action(deps, (ctx, method: string) => methodSwitch(ctx, method, false)));

  auth.command('config').description("The app's sign-in configuration: the login methods, the token lifetimes and the password rules").action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      const settings = await signInSettings.get(c, appId);
      ctx.io.result({
        loginMethods: loginMethods(settings),
        tokens: tokensView(settings),
        ...passwordView(settings),
        ...(settings.emailConfirmation === undefined ? {} : { emailConfirmation: settings.emailConfirmation }),
        signUp: settings.signUp,
      });
    }),
  );
  const ttl = (value: string) => Number.parseInt(value, 10);
  const policy = auth
    .command('password-policy')
    .description("Set the app's password rules: a preset, or custom rules never below 8 characters. Changing them signs nobody out and forces nobody to reset")
    .option('--preset <preset>', `basic | recommended | strict | compliance | custom`)
    .option('--min-length <n>', 'Custom: the shortest password, 8 to 128 characters', ttl);
  for (const [, flag, what] of RULES) policy.option(`${flag} [bool]`, `Custom: ${what} (true or false)`, yesNo);
  policy
    .option('--expiry-days <days>', `Compliance or custom: passwords expire after off | ${EXPIRY_DAYS.join(' | ')} days. Current guidance advises against it unless a compliance rule requires it`, expiryOf)
    .option('--history <n>', "Compliance or custom: don't allow the last N passwords, off or 1 to 24", historyOf)
    .option('--access-token-ttl <seconds>', 'Moved to `bridge auth token-lifetime`; still taken here for one release', ttl)
    .option('--refresh-token-ttl <seconds>', 'Moved to `bridge auth token-lifetime`; still taken here for one release', ttl)
    .action(
      action(deps, async (ctx, opts: Record<string, unknown> & { preset?: string; minLength?: number; accessTokenTtl?: number; refreshTokenTtl?: number; expiryDays?: number | null; history?: number }) => {
        const { c, appId } = await ctx.forApp();
        const current = await signInSettings.get(c, appId);
        const lifetimes = lifetimesOf(current, opts);
        const given = RULES.filter(([name]) => opts[name] !== undefined);
        if (opts.preset !== undefined && !PRESETS.includes(opts.preset)) throw new CliError('invalid', `--preset is one of ${PRESETS.join(', ')}.`);
        if (opts.preset !== undefined && opts.preset !== 'custom' && (given.length > 0 || opts.minLength !== undefined)) {
          throw new CliError('invalid', `The ${opts.preset} preset sets its own rules. Nothing was changed.`, { hint: 'Use --preset custom to set rules of your own.' });
        }
        if (opts.minLength !== undefined && (!Number.isInteger(opts.minLength) || opts.minLength < 8 || opts.minLength > 128)) throw new CliError('invalid', '--min-length is 8 to 128 characters. Nothing was changed.');
        const custom = opts.preset === 'custom' || (opts.preset === undefined && (given.length > 0 || opts.minLength !== undefined));
        const password = custom
          ? { preset: 'custom', minLength: opts.minLength ?? (current.password['minLength'] as number | undefined) ?? 8, ...Object.fromEntries(RULES.map(([name]) => [name, (opts[name] as boolean | undefined) ?? current.password[name] === true])) }
          : opts.preset === undefined
            ? undefined
            : { preset: opts.preset };
        // Password expiry and history: only with Compliance or Custom; another preset turns them off.
        const aging: Pick<SignInSettingsFields, 'passwordExpiryDays' | 'passwordHistory'> = {};
        if (opts.expiryDays !== undefined) aging.passwordExpiryDays = opts.expiryDays;
        if (opts.history !== undefined) aging.passwordHistory = opts.history;
        const presetAfter = (password?.['preset'] as string | undefined) ?? (current.password['preset'] as string | undefined) ?? 'basic';
        const agingOn = (aging.passwordExpiryDays ?? null) !== null || (aging.passwordHistory ?? 0) > 0;
        if (agingOn && !AGING_PRESETS.includes(presetAfter)) {
          throw new CliError('invalid', `Password expiry and history come with the compliance or custom rules, not ${presetAfter}. Nothing was changed.`, { hint: 'Add --preset compliance (or custom).' });
        }
        if (password !== undefined && !AGING_PRESETS.includes(presetAfter) && current.passwordExpiryDays !== undefined) {
          if (aging.passwordExpiryDays === undefined && current.passwordExpiryDays !== null) aging.passwordExpiryDays = null;
          if (aging.passwordHistory === undefined && (current.passwordHistory ?? 0) > 0) aging.passwordHistory = 0;
          if (Object.keys(aging).length > 0) ctx.io.info(`Password expiry and history come with compliance or custom: ${presetAfter} turns them off.`);
        }
        if (password === undefined && Object.keys(lifetimes).length === 0 && Object.keys(aging).length === 0) {
          throw new CliError('invalid', 'Nothing to change: give --preset, the custom rules (--min-length, --require-upper, --block-common, …), --expiry-days or --history.', { hint: 'Token lifetimes moved to `bridge auth token-lifetime`.' });
        }
        if (aging.passwordExpiryDays != null) ctx.io.info(current.passwordFacts?.aging?.warning ?? 'Current guidance (NIST SP 800-63B) advises against expiring passwords unless a compliance rule requires it.');
        if (Object.keys(lifetimes).length > 0) ctx.io.info('Token lifetimes moved to `bridge auth token-lifetime`. This command still sets them for one more release.');
        let changed: SignInSettings;
        try {
          changed = await signInSettings.update(c, appId, { ...(password === undefined ? {} : { password }), ...aging, ...(Object.keys(lifetimes).length === 0 ? {} : { lifetimes }) });
        } catch (error) {
          return rulesRefused(error);
        }
        ctx.io.result({ ...passwordView(changed), ...(Object.keys(lifetimes).length === 0 ? {} : { tokens: tokensView(changed), moved: 'Token lifetimes: use bridge auth token-lifetime' }) });
      }),
    );

  auth
    .command('token-lifetime')
    .description('Set the token and session lifetimes, in seconds (moved here from password-policy). Nobody is signed out')
    .option('--access-token-ttl <seconds>', 'How long an access token lives', ttl)
    .option('--refresh-token-ttl <seconds>', 'How long a session lasts in all (the 0.x refresh token lifetime)', ttl)
    .option('--session-idle-ttl <seconds>', 'How long a session lasts without being used', ttl)
    .action(
      action(deps, async (ctx, opts: { accessTokenTtl?: number; refreshTokenTtl?: number; sessionIdleTtl?: number }) => {
        const { c, appId } = await ctx.forApp();
        const lifetimes = lifetimesOf(await signInSettings.get(c, appId), opts);
        if (Object.keys(lifetimes).length === 0) throw new CliError('invalid', 'Nothing to change: give --access-token-ttl, --refresh-token-ttl or --session-idle-ttl.');
        ctx.io.result({ tokens: tokensView(await signInSettings.update(c, appId, { lifetimes })) });
      }),
    );

  auth
    .command('email-confirmation [choice]')
    .description('What sign-in, sign-up and forgot-password emails carry: code (a 6-digit code to type) or link (a link to open). Without a choice, shows it')
    .action(
      action(deps, async (ctx, choice: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        if (choice === undefined) {
          const settings = await signInSettings.get(c, appId);
          if (settings.emailConfirmation === undefined) throw new CliError('not-offered', 'This Bridge has no choice of code or link yet: its emails carry a link.');
          return ctx.io.result({ emailConfirmation: settings.emailConfirmation });
        }
        const wanted = choice.trim().toLowerCase();
        if (wanted !== 'code' && wanted !== 'link') throw new CliError('invalid', `"${choice}" is neither code nor link. Nothing was changed.`, { hint: 'code: the email holds a 6-digit code to type. link: the email holds a link to open.' });
        const settings = await signInSettings.update(c, appId, { emailConfirmation: wanted });
        ctx.io.result({ emailConfirmation: settings.emailConfirmation ?? wanted });
      }),
    );

  const mfa = auth.command('mfa').description('Multi-factor authentication: on or off, where it is required, the ways allowed, the remembered device, and the lock-out dry run');
  mfa.command('show').description("The app's MFA settings").action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result({ mfa: mfaView(await signInSettings.get(c, appId)) });
    }),
  );
  /** The MFA choice a change leads to, whole (the dry run takes it whole), and the change itself. */
  const mfaAfter = (current: MfaSettings, change: NonNullable<SignInSettingsFields['mfa']>): MfaSettings => ({ ...current, ...change, methods: { ...current.methods, ...change.methods } });
  const daysOf = (value: string) => {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 90) throw new InvalidArgumentError('0 (off) to 90 days');
    return days;
  };
  mfa
    .command('set')
    .description('Change MFA: only what you pass changes. Requiring it in every workspace runs the lock-out dry run first and needs --yes')
    .option('--on', 'Turn MFA on for the app')
    .option('--off', 'Turn MFA off for the app')
    .option('--required-in <where>', 'workspaces (those that turned MFA on) | all (every workspace)')
    .option('--methods <list>', `The ways allowed, comma-separated: totp (authenticator app), email, sms (text message). ${STRONGEST_NOTE}`)
    .option('--remember-days <days>', 'Remember a device that passed the second step for this many days: 0 (off) to 90', daysOf)
    .option('--yes', 'Confirm requiring MFA in every workspace after the dry run')
    .action(
      action(deps, async (ctx, opts: { on?: boolean; off?: boolean; requiredIn?: string; methods?: string; rememberDays?: number; yes?: boolean }) => {
        if (opts.on === true && opts.off === true) throw new CliError('invalid', '--on or --off, not both.');
        if (opts.requiredIn !== undefined && opts.requiredIn !== 'workspaces' && opts.requiredIn !== 'all') throw new CliError('invalid', '--required-in is workspaces or all. Nothing was changed.');
        const change: NonNullable<SignInSettingsFields['mfa']> = {
          ...(opts.requiredIn === undefined ? {} : { requiredIn: opts.requiredIn as 'workspaces' | 'all' }),
          ...(opts.methods === undefined ? {} : { methods: methodsOf(opts.methods) }),
          ...(opts.rememberDays === undefined ? {} : { rememberDeviceDays: opts.rememberDays }),
        };
        const secondStep = opts.on === true ? true : opts.off === true ? false : undefined;
        if (Object.keys(change).length === 0 && secondStep === undefined) throw new CliError('invalid', 'Nothing to change: give --on, --off, --required-in, --methods or --remember-days.');
        const { c, appId } = await ctx.forApp();
        const current = await signInSettings.get(c, appId);
        if (current.mfa === undefined && Object.keys(change).length > 0) throw new CliError('not-offered', 'This Bridge has no MFA choices yet: only --on and --off. Nothing was changed.');
        const after = current.mfa === undefined ? undefined : mfaAfter(current.mfa, change);
        if (after !== undefined && (secondStep ?? current.secondStep === true) && !Object.values(after.methods).some(Boolean)) throw new CliError('invalid', 'MFA on needs at least one way: give --methods with totp, email or sms. Nothing was changed.');
        // Requiring MFA in every workspace: who would be locked out, before anything is changed.
        if (after !== undefined && after.requiredIn === 'all' && current.mfa?.requiredIn !== 'all') {
          const dryRun = dryRunView(await signInSettings.mfaDryRun(c, appId, { all: true, mfa: after }));
          if (opts.yes !== true) {
            throw new CliError('invalid', `Requiring MFA in every workspace: ${String(dryRun.lockedOut)} of ${String(dryRun.total)} people would be locked out, ${String(dryRun.setUpAtNextSignIn)} set a way up at their next sign-in. Nothing was changed.`, { hint: 'Confirm with --yes. `bridge auth mfa dry-run --all` lists who.', details: { dryRun } });
          }
          ctx.io.info(`Dry run: ${String(dryRun.lockedOut)} of ${String(dryRun.total)} people locked out.`);
        }
        const fields: SignInSettingsFields = { ...(secondStep === undefined ? {} : { secondStep }), ...(Object.keys(change).length === 0 ? {} : { mfa: change }) };
        let changed: SignInSettings;
        try {
          changed = await signInSettings.update(c, appId, fields);
        } catch (error) {
          return textsRefused(error, change.methods?.sms === true && current.mfa?.methods.sms !== true);
        }
        if (change.methods !== undefined && !change.methods.totp) ctx.io.info(STRONGEST_NOTE);
        ctx.io.result({ mfa: mfaView(changed) });
      }),
    );
  mfa
    .command('dry-run')
    .description('Who would be locked out if MFA were required: in every workspace (--all), in one workspace (--workspace), or for these users (--users). Changes nothing')
    .option('--all', 'Every person of the app, as "required in every workspace"')
    .option('--workspace <id>', "A workspace's members, as turning that workspace's MFA on (its id or name)")
    .option('--users <ids>', 'These user ids, comma-separated')
    .option('--methods <list>', 'The ways being considered, comma-separated (default: the app\'s)')
    .action(
      action(deps, async (ctx, opts: { all?: boolean; workspace?: string; users?: string; methods?: string }) => {
        const chosen = [opts.all === true, opts.workspace !== undefined, opts.users !== undefined].filter(Boolean).length;
        if (chosen !== 1) throw new CliError('invalid', 'Give one of --all, --workspace <id> or --users <ids>.');
        const { c, appId } = await ctx.forApp();
        const current = await signInSettings.get(c, appId);
        let users: string[] | undefined;
        if (opts.users !== undefined) users = opts.users.split(',').map((each) => each.trim()).filter((each) => each !== '');
        if (opts.workspace !== undefined) {
          const workspaceId = await findWorkspaceId(ctx, opts.workspace);
          users = [];
          let after: string | undefined;
          for (;;) {
            const page = (await c.person<{ id: string; user: { id?: string } }[]>('membersList', { params: { appId, workspaceId }, query: { limit: '100', after } })).body;
            users.push(...page.map((each) => each.user.id).filter((each): each is string => typeof each === 'string'));
            if (page.length < 100 || users.length >= 5000) break;
            after = page.at(-1)?.id;
          }
        }
        const considered = current.mfa === undefined ? undefined : mfaAfter(current.mfa, { ...(opts.all === true ? { requiredIn: 'all' as const } : {}), ...(opts.methods === undefined ? {} : { methods: methodsOf(opts.methods) }) });
        const result = await signInSettings.mfaDryRun(c, appId, { ...(opts.all === true ? { all: true as const } : { users: users ?? [] }), ...(considered === undefined ? {} : { mfa: considered }) });
        ctx.io.result({ dryRun: dryRunView(result) });
      }),
    );

  const providers = auth.command('providers').description('Social sign-in providers: Google, LinkedIn, Microsoft, GitHub and Facebook');
  providers.command('list').description('Each provider: on or off, its credentials saved, and the return address to register with it').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      const settings = await signInSettings.get(c, appId);
      ctx.io.result({ providers: Object.fromEntries(PROVIDERS.map((each) => [each.cli, providerState(settings, each)])) });
    }),
  );
  providers
    .command('set <provider>')
    .description("Save a provider's client ID and secret (google, linkedin, microsoft, github, facebook), and print the exact return address to register with it")
    .requiredOption('--client-id <id>', "The client ID from the provider's console (Microsoft: Application (client) ID)")
    .requiredOption('--client-secret <secret>', "The client secret (Microsoft: the secret's Value, not its Secret ID)")
    .option('--who-can-sign-in <who>', 'Microsoft: any (default) | work | personal | directory')
    .option('--directory <id>', 'Microsoft with --who-can-sign-in directory: the directory (tenant) id or domain')
    .option('--secret-expires-at <date>', 'Microsoft: when the client secret expires, YYYY-MM-DD (default: 24 months from now)')
    .option('--enable', 'Also switch the provider on')
    .action(
      action(deps, async (ctx, name: string, opts: { clientId: string; clientSecret: string; whoCanSignIn?: string; directory?: string; secretExpiresAt?: string; enable?: boolean }) => {
        const provider = providerOf(name);
        if (provider === null) {
          throw new CliError('invalid', `"${name}" is not a provider Bridge offers.`, { hint: `Use one of: ${PROVIDERS.map((each) => each.cli).join(', ')}.${name.toLowerCase() === 'apple' ? ' Apple is not available on Bridge yet.' : ''}` });
        }
        const microsoft = provider.key === 'azure';
        if (!microsoft && (opts.whoCanSignIn !== undefined || opts.directory !== undefined || opts.secretExpiresAt !== undefined)) throw new CliError('invalid', '--who-can-sign-in, --directory and --secret-expires-at are for Microsoft only. Nothing was changed.');
        const who = opts.whoCanSignIn ?? (opts.directory !== undefined ? 'directory' : 'any');
        if (microsoft && !['any', 'work', 'personal', 'directory'].includes(who)) throw new CliError('invalid', '--who-can-sign-in is any, work, personal or directory.');
        if (who === 'directory' && (opts.directory === undefined || opts.directory.trim() === '')) throw new CliError('invalid', '--who-can-sign-in directory needs --directory <id or domain>. Nothing was changed.');
        if (opts.secretExpiresAt !== undefined && Number.isNaN(new Date(opts.secretExpiresAt).getTime())) throw new CliError('invalid', '--secret-expires-at is a date such as 2028-11-27.');
        const tenantId = !microsoft ? undefined : who === 'directory' ? (opts.directory as string).trim() : WHO[who as keyof typeof WHO];
        const { c, appId } = await ctx.forApp();
        let settings = await signInSettings.saveProvider(c, appId, provider.key, { clientId: opts.clientId, clientSecret: opts.clientSecret, ...(tenantId === undefined ? {} : { tenantId }), ...(opts.secretExpiresAt === undefined ? {} : { secretExpiresAt: opts.secretExpiresAt }) });
        if (opts.enable === true) settings = await signInSettings.update(c, appId, { social: { [provider.key]: true } });
        const state = providerState(settings, provider);
        if (state.returnAddress !== undefined) ctx.io.info(`Register this return address with ${provider.name}: ${state.returnAddress}${microsoft ? ' (platform Web)' : ''}`);
        ctx.io.result({ provider: provider.cli, ...state });
      }),
    );

  const userCommand = program.commands.find((each) => each.name() === 'user') ?? program.command('user').description("The app's users");
  // `bridge users mfa-reset` reads as well as `bridge user mfa-reset`.
  if (!program.commands.some((each) => each.name() === 'users' || each.aliases().includes('users'))) userCommand.alias('users');
  const passkeys = userCommand.command('passkeys').description("A user's passkeys, for the app's admins: see them, and remove a lost device's");
  /** The User an email names, across the app: Accounts' users route, as `event auth-attempts` finds them. */
  const userByEmail = async (ctx: Context, email: string) => {
    const { c, appId } = await ctx.forApp();
    const found = (await c.person<{ id: string; email: string }[]>('usersList', { params: { appId }, query: { email } })).body.find((each) => each.email.toLowerCase() === email.toLowerCase());
    if (found === undefined) throw new CliError('not-found', `No user with the email ${email} in this app.`, { hint: '`bridge user list --tenant-id <workspace>` shows a workspace\'s users.' });
    return { c, appId, user: found };
  };
  passkeys.command('list <email>').description("The user's passkeys: name, where it lives (iCloud Keychain, Google Password Manager…), added, last used, synced").action(
    action(deps, async (ctx, email: string) => {
      const { c, appId, user } = await userByEmail(ctx, email);
      const list = await userPasskeys.list(c, appId, user.id);
      ctx.io.result({ user: user.email, passkeys: list.map((each) => ({ id: each.id, name: each.name, provider: each.authenticator?.name ?? 'Passkey', createdAt: each.createdAt, lastUsedAt: each.lastUsedAt, syncs: each.backedUp === true })) });
    }),
  );
  passkeys
    .command('remove <email> <passkeyId>')
    .description('Remove one of the user\'s passkeys (logged, and the user is emailed). The last one too: they then sign in another way')
    .option('--dry-run', 'Say which passkey it is, and remove nothing')
    .option('--yes', 'Confirm the removal')
    .action(
      action(deps, async (ctx, email: string, passkeyId: string, opts: { dryRun?: boolean; yes?: boolean }) => {
        const { c, appId, user } = await userByEmail(ctx, email);
        const found = (await userPasskeys.list(c, appId, user.id)).find((each) => each.id === passkeyId);
        if (found === undefined) throw new CliError('not-found', `${user.email} has no passkey ${passkeyId}.`, { hint: `\`bridge user passkeys list ${user.email}\` shows them.` });
        const view = { id: found.id, name: found.name, provider: found.authenticator?.name ?? 'Passkey', lastUsedAt: found.lastUsedAt };
        if (opts.dryRun === true) return ctx.io.result({ dryRun: true, user: user.email, passkey: view });
        if (opts.yes !== true) throw new CliError('invalid', 'Confirm the removal with --yes. `--dry-run` shows which passkey it is first.');
        await userPasskeys.remove(c, appId, user.id, passkeyId);
        ctx.io.result({ removed: true, user: user.email, passkey: view });
      }),
    );

  userCommand
    .command('mfa-reset <user>')
    .description("Reset a user's two-step verification (a lost phone), by user id or email: every way they set up, their recovery codes and remembered devices go, they are signed out everywhere and emailed. Logged")
    .option('--dry-run', 'Say who it is, and reset nothing')
    .option('--yes', 'Confirm the reset')
    .action(
      action(deps, async (ctx, who: string, opts: { dryRun?: boolean; yes?: boolean }) => {
        const { c, appId, user } = who.includes('@') ? await userByEmail(ctx, who) : { ...(await ctx.forApp()), user: { id: who, email: null as string | null } };
        const view = { id: user.id, ...(user.email === null ? {} : { email: user.email }) };
        if (opts.dryRun === true) return ctx.io.result({ dryRun: true, user: view, resets: ['authenticator app', 'phone', 'recovery codes', 'remembered devices'], signsOut: true, emailed: true });
        if (opts.yes !== true) throw new CliError('invalid', 'Confirm the reset with --yes. It removes every way of their second step and signs them out everywhere; `--dry-run` shows who it is first.');
        await userSecondStep.reset(c, appId, user.id);
        ctx.io.result({ reset: true, user: view, next: 'They set two-step verification up again at their next sign-in.' });
      }),
    );

  const event = program.command('event').description("The app's event log: sign-ups, sign-ins, workspaces and subscriptions");
  event
    .command('list')
    .description('Events, newest first')
    .option('--type <type>', 'Only events of this exact type')
    .option('--tenant-id <id>', 'Only events of this workspace')
    .option('--since <duration>', 'How far back: 24h, 7d, or an ISO date')
    .option('--limit <n>', 'At most this many (default 50, at most 500)', (value) => Number.parseInt(value, 10))
    .action(
      action(deps, async (ctx, opts: { type?: string; tenantId?: string; since?: string; limit?: number }) => {
        const { c, appId } = await ctx.forApp();
        const limit = Math.min(opts.limit !== undefined && opts.limit > 0 ? opts.limit : 50, 500);
        const workspaceId = opts.tenantId === undefined ? undefined : await findWorkspaceId(ctx, opts.tenantId);
        const events = await listEvents(c, appId, { limit, ...(opts.type === undefined ? {} : { type: opts.type }), ...(workspaceId === undefined ? {} : { workspaceId }), ...(opts.since === undefined ? {} : { from: sinceOf(opts.since, deps.now?.() ?? Date.now()) }) });
        ctx.io.result({ events: events.map((each) => ({ id: each.id, type: each.type, tenantId: each.workspaceId, userId: each.userId, data: each.data, createdAt: each.time })) });
      }),
    );

  const setup = program.command('setup').description('Set-up steps for the app');
  setup
    .command('communication')
    .description("Set the sender name and address of the app's emails, sent through Bridge's own email provider")
    .option('--from-address <email>', 'The sender address. A new address is verified by email before Bridge uses it')
    .option('--from-name <name>', 'The sender\'s display name')
    .action(
      action(deps, async (ctx, opts: { fromAddress?: string; fromName?: string }) => {
        const { c, appId } = await ctx.forApp();
        if (opts.fromAddress === undefined) {
          if (opts.fromName !== undefined) throw new CliError('invalid', '--from-name goes with --from-address.');
          return ctx.io.result({ sender: await sender.get(c, appId) });
        }
        ctx.io.result({ sender: await sender.set(c, appId, { address: opts.fromAddress, ...(opts.fromName === undefined ? {} : { name: opts.fromName }) }) });
      }),
    );

  setup
    .command('status')
    .description('The readiness checklist: what is configured, what is missing and the next step for each, and what production needs')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        const [app, settings, from, health, listed] = await Promise.all([
          apps.get(c, appId),
          signInSettings.get(c, appId),
          sender.get(c, appId),
          connection.health(c, appId).catch(() => null),
          plans.list(c, appId, false),
        ]);
        const returns = (app.addresses ?? []).filter((each) => each.uses.includes('sign-in-return'));
        const origins = (app.addresses ?? []).filter((each) => each.uses.includes('browser-origin'));
        const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
        const items: SetupItem[] = [
          returns.length === 0
            ? { id: 'sign_in_return', label: 'Sign-in return address', status: 'missing', detail: 'The app has no address a sign-in may return to.', nextStep: 'bridge app address add <url> --use sign-in-return' }
            : { id: 'sign_in_return', label: 'Sign-in return address', status: 'configured', detail: `${String(returns.length)} address(es); the default is ${app.defaultReturn ?? 'not set'}.` },
          origins.length === 0
            ? { id: 'browser_origin', label: 'Browser origin', status: 'missing', detail: 'No page may call Bridge from the browser.', nextStep: 'bridge app address add <url> --use browser-origin' }
            : { id: 'browser_origin', label: 'Browser origin', status: 'configured', detail: `${String(origins.length)} origin(s).` },
          { id: 'sign_in_methods', label: 'Sign-in methods', status: 'configured', detail: Object.entries(settings.methods).filter(([, on]) => on).map(([name]) => name).join(', ') },
          from === null || from.address === undefined
            ? { id: 'email_sender', label: 'Email sender', status: 'missing', detail: "Emails go out under Bridge's own sender.", nextStep: 'bridge setup communication --from-address <email>', productionOnly: true }
            : from.state === 'verified' || from.state === 'active'
              ? { id: 'email_sender', label: 'Email sender', status: 'configured', detail: `Emails go out from ${from.address}.` }
              : { id: 'email_sender', label: 'Email sender', status: 'attention', detail: `${from.address} is ${from.state ?? 'not verified yet'}.`, nextStep: 'bridge setup communication --from-address <email> sends the verification again.', productionOnly: true },
          health === null || health.connected === false
            ? { id: 'payments', label: 'Payments', status: 'missing', detail: 'Stripe is not connected.', nextStep: 'bridge stripe connect' }
            : { id: 'payments', label: 'Payments', status: 'configured', detail: `Stripe is ${health.status ?? health.connection ?? 'connected'}.` },
          listed.length === 0
            ? { id: 'plans', label: 'Plans', status: 'missing', detail: 'No plan is on offer.', nextStep: 'bridge plan create <key> --name <name> --price "<amount> <CURRENCY>/<interval>"' }
            : { id: 'plans', label: 'Plans', status: 'configured', detail: `${String(listed.length)} plan(s).` },
        ];
        const productionNeeds = [
          ...(returns.some((each) => local(each.url)) ? ['A sign-in return address that is not on localhost.'] : []),
          ...(origins.some((each) => local(each.url)) ? ['A browser origin that is not on localhost.'] : []),
          ...items.filter((each) => each.productionOnly === true && each.status !== 'configured').map((each) => `${each.label}: ${each.nextStep ?? each.detail}`),
        ];
        ctx.io.result({ app: { id: app.id, name: app.name }, items, ready: items.every((each) => each.status === 'configured'), productionNeeds });
      }),
    );
}

interface SetupItem {
  readonly id: string;
  readonly label: string;
  readonly status: 'configured' | 'missing' | 'attention';
  readonly detail: string;
  readonly nextStep?: string;
  readonly productionOnly?: boolean;
}
