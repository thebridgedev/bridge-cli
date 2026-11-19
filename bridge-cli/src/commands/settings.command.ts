import { InvalidArgumentError, type Command } from 'commander';
import { branding, listEvents, sender, signInSettings, type BrandingFields, type SignInSettings } from '../api/settings.js';
import { apps } from '../api/apps.js';
import { connection, plans } from '../api/billing.js';
import { CliError } from '../core/errors.js';
import { action, type Context, type Deps } from './context.js';
import { findWorkspaceId } from './workspace-id.js';

/**
 * The commands that read and change how the app looks and signs people in, and what happened in it: `branding`,
 * `auth methods|config|password-policy`, `event list` and `setup communication` (the 0.x commands of those names, on
 * version 2). What the new Bridge does not have yet (social sign-in, MFA, a free-form stylesheet) is said, never faked.
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
function loginMethods(settings: SignInSettings) {
  return {
    password: { enabled: settings.methods.password },
    magicLink: { enabled: settings.methods.magicLink },
    passkeys: { enabled: settings.methods.passkeys },
    mfa: { ...NOT_YET, note: 'Second factor, not a standalone login method; not available on Bridge yet' },
    socialProviders: { google: NOT_YET, linkedin: NOT_YET, azureAd: NOT_YET, apple: NOT_YET, github: NOT_YET, facebook: NOT_YET },
  };
}

/** The method names `auth methods enable|disable` takes, in any case, with kebab or snake forms (`magic-link`). */
const SWITCHES = { magiclink: 'magicLink', passkeys: 'passkeys', password: 'password' } as const;
const NOT_AVAILABLE = ['mfa', 'google', 'linkedin', 'azuread', 'apple', 'github', 'facebook'];

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
  const field = (SWITCHES as Record<string, string | undefined>)[wanted];
  if (field === undefined) throw new CliError('invalid', `Unknown login method "${input}".`, { hint: `Use one of: magicLink, passkeys, password. \`bridge auth methods list\` shows them all.` });
  const { c, appId } = await ctx.forApp();
  const settings = await signInSettings.update(c, appId, { methods: { [field]: on } });
  ctx.io.result({ method: field, enabled: (settings.methods as Record<string, boolean>)[field] === true, loginMethods: loginMethods(settings) });
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
  methods.command('enable <method>').description('Switch a login method on: magicLink, passkeys or password. Social sign-in and MFA are not available on Bridge yet').action(action(deps, (ctx, method: string) => methodSwitch(ctx, method, true)));
  methods.command('disable <method>').description('Switch a login method off. Bridge refuses to switch off the last one').action(action(deps, (ctx, method: string) => methodSwitch(ctx, method, false)));

  auth.command('config').description("The app's sign-in configuration: the login methods, the token lifetimes and the password rules").action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      const settings = await signInSettings.get(c, appId);
      ctx.io.result({
        loginMethods: loginMethods(settings),
        tokens: { accessTokenTTL: settings.lifetimes.accessTokenSeconds, refreshTokenTTL: settings.lifetimes.sessionAbsoluteSeconds, sessionIdleTTL: settings.lifetimes.sessionIdleSeconds },
        passwordRules: settings.password,
        signUp: settings.signUp,
      });
    }),
  );
  auth
    .command('password-policy')
    .description('Set the token lifetimes (the 0.x name of this command, which never set password rules): both in seconds')
    .option('--access-token-ttl <seconds>', 'How long an access token lives', (value) => Number.parseInt(value, 10))
    .option('--refresh-token-ttl <seconds>', 'How long a session lasts in all (the 0.x refresh token lifetime)', (value) => Number.parseInt(value, 10))
    .action(
      action(deps, async (ctx, opts: { accessTokenTtl?: number; refreshTokenTtl?: number }) => {
        const { c, appId } = await ctx.forApp();
        const current = await signInSettings.get(c, appId);
        const lifetimes: Record<string, number> = {};
        for (const [flag, name, value] of [['--access-token-ttl', 'accessTokenSeconds', opts.accessTokenTtl], ['--refresh-token-ttl', 'sessionAbsoluteSeconds', opts.refreshTokenTtl]] as const) {
          if (value === undefined) continue;
          const range = current.bounds?.lifetimes?.[name];
          if (range !== undefined && (value < range.min || value > range.max)) throw new CliError('invalid', `${flag} is ${String(range.min)} to ${String(range.max)} seconds on Bridge. Nothing was changed.`);
          lifetimes[name] = value;
        }
        if (Object.keys(lifetimes).length === 0) throw new CliError('invalid', 'Nothing to change: give --access-token-ttl or --refresh-token-ttl.');
        // A session's idle time never outlives its whole life: a shorter life shortens the idle time with it.
        if (opts.refreshTokenTtl !== undefined && current.lifetimes.sessionIdleSeconds > opts.refreshTokenTtl) lifetimes['sessionIdleSeconds'] = opts.refreshTokenTtl;
        const changed = await signInSettings.update(c, appId, { lifetimes });
        ctx.io.result({ tokens: { accessTokenTTL: changed.lifetimes.accessTokenSeconds, refreshTokenTTL: changed.lifetimes.sessionAbsoluteSeconds, sessionIdleTTL: changed.lifetimes.sessionIdleSeconds } });
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
