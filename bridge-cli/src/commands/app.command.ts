import type { Command } from 'commander';
import { resolve } from 'node:path';
import { ADDRESS_USES, apps, checkUses, type AddressUse, type AppFields } from '../api/apps.js';
import { CliError } from '../core/errors.js';
import { normalizeIssuer, secureUrl } from '../core/urls.js';
import { setEnvValue } from '../setup/env-file.js';
import { action, collect, type Deps } from './context.js';

interface ProfileOptions {
  name?: string;
  logo?: string;
  website?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  supportContact?: string;
}

/** The longest support contact Bridge takes (an email address's own limit). */
const SUPPORT_CONTACT_MAX = 320;

/** A support contact is an email address or an https address: the suspended message shows it to the person. */
export function checkSupportContact(typed: string): string {
  const value = typed.trim();
  const email = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(value);
  let https = false;
  try {
    const url = new URL(value);
    https = url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    https = false;
  }
  if (value.length > SUPPORT_CONTACT_MAX || !(email || https)) {
    throw new CliError('invalid', `--support-contact is an email address (support@example.com) or an https address (https://example.com/help), at most ${String(SUPPORT_CONTACT_MAX)} characters, or "none": ${typed}`);
  }
  return value;
}

/** The profile fields given; "none" clears one. */
function profile(opts: ProfileOptions): AppFields {
  const fields: Record<string, string | null> = {};
  if (opts.supportContact !== undefined) fields['supportContact'] = opts.supportContact === 'none' ? null : checkSupportContact(opts.supportContact);
  for (const name of ['logo', 'website', 'privacyPolicy', 'termsOfService'] as const) {
    const value = opts[name];
    if (value !== undefined) fields[name] = value === 'none' ? null : value;
  }
  return { ...(opts.name === undefined ? {} : { name: opts.name }), ...fields };
}

const withProfileOptions = (cmd: Command) =>
  cmd
    .option('--logo <url>', 'Logo address ("none" clears it)')
    .option('--website <url>', 'Website ("none" clears it)')
    .option('--privacy-policy <url>', 'Privacy policy ("none" clears it)')
    .option('--terms-of-service <url>', 'Terms of service ("none" clears it)')
    .option('--support-contact <email|url>', 'Where a suspended person turns for help: an email address or an https address ("none" clears it)');

const USES = `one of ${ADDRESS_USES.join(', ')}; repeat for several`;

export function registerAppCommands(program: Command, deps: Deps): void {
  const app = program.command('app').description('Your apps: create them, choose the one commands act on, set their addresses');

  app
    .command('list')
    .description('The apps of your workspace')
    .action(
      action(deps, async (ctx) => {
        const c = await ctx.client();
        const current = (await ctx.settings()).apps?.[await ctx.issuer()];
        const listed = await apps.list(c);
        await ctx.config.update((settings) => {
          settings.appNames = { ...settings.appNames, ...Object.fromEntries(listed.map((each) => [each.id, each.name])) };
        });
        ctx.io.result(listed.map((each) => ({ ...each, current: each.id === current })));
      }),
    );

  withProfileOptions(
    app
      .command('create')
      .description('Create an app, and choose it for the commands that follow')
      .requiredOption('--name <name>', 'The app\'s name')
      .option('--sign-in-return <url>', 'An address sign-in may return to; repeat for several', collect)
      .option('--email-links <url>', 'The page email links (sign-up, password reset, invites) open', collect)
      .option('--browser-origin <origin>', 'An origin whose pages may call Bridge from the browser; repeat for several', collect)
      .option('--no-use', 'Create it without choosing it'),
  ).action(
    action(deps, async (ctx, opts: ProfileOptions & { signInReturn?: string[]; emailLinks?: string[]; browserOrigin?: string[]; use?: boolean }) => {
      const c = await ctx.client();
      const byUrl = new Map<string, Set<string>>();
      const add = (urls: string[] | undefined, use: string) => urls?.forEach((url) => byUrl.set(url, (byUrl.get(url) ?? new Set()).add(use)));
      add(opts.signInReturn, 'sign-in-return');
      add(opts.emailLinks, 'email-links');
      add(opts.browserOrigin, 'browser-origin');
      const addresses = [...byUrl].map(([url, uses]) => ({ url, uses: checkUses([...uses]) }));
      const made = await apps.create(c, {
        ...profile(opts),
        name: opts.name as string,
        ...(addresses.length === 0 ? {} : { addresses }),
        ...(opts.signInReturn?.[0] === undefined ? {} : { defaultReturn: opts.signInReturn[0] }),
      });
      if (opts.use !== false) {
        const issuer = await ctx.issuer();
        await ctx.config.update((settings) => {
          settings.apps = { ...settings.apps, [issuer]: made.id };
          settings.appNames = { ...settings.appNames, [made.id]: made.name };
        });
        ctx.io.info(`Created ${made.name} (${made.id}); commands now act on it.`);
      }
      ctx.io.result(made);
    }),
  );

  app
    .command('use <id>')
    .description('Choose the app the commands act on')
    .action(
      action(deps, async (ctx, id: string) => {
        const c = await ctx.client();
        const found = await apps.get(c, id);
        const issuer = await ctx.issuer();
        await ctx.config.update((settings) => {
          settings.apps = { ...settings.apps, [issuer]: found.id };
          settings.appNames = { ...settings.appNames, [found.id]: found.name };
        });
        ctx.io.info(`Commands now act on ${found.name} (${found.id}).`);
        ctx.io.result({ id: found.id, name: found.name });
      }),
    );

  app
    .command('get')
    .description('The app: its addresses, profile and how its tokens are checked')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await apps.get(c, appId));
      }),
    );

  withProfileOptions(app.command('update').description('Rename the app or change its public profile').option('--name <name>', 'The app\'s name')).action(
    action(deps, async (ctx, opts: ProfileOptions) => {
      const fields = profile(opts);
      if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change: give --name, --logo, --website, --privacy-policy, --terms-of-service or --support-contact.');
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await apps.update(c, appId, fields));
    }),
  );

  app
    .command('delete')
    .description('Delete the app. Its keys, plans and flags go with it')
    .requiredOption('--yes', 'Confirm the deletion')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        const issuer = await ctx.issuer();
        const answer = await apps.remove(c, appId);
        await ctx.config.update((settings) => {
          if (settings.apps?.[issuer] === appId) delete settings.apps[issuer];
        });
        ctx.io.result(answer ?? { deleted: appId });
      }),
    );

  app
    .command('default-return <url>')
    .description('The sign-in return used when a sign-in names none ("none" clears it). It must be one of the app\'s sign-in returns')
    .action(
      action(deps, async (ctx, url: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await apps.update(c, appId, { defaultReturn: url === 'none' ? null : url }));
      }),
    );

  app
    .command('setup')
    .description('Hook up your project to the app: its issuer into your .env file, and your dev address as a browser origin and email-links page')
    .option('--url <url>', 'Your app\'s address while developing', 'http://localhost:5173')
    .option('--auth-path <path>', 'Where your app shows Bridge\'s sign-in pages; email links land there', '/auth')
    // Not --env-file: some Node.js versions read that flag anywhere on the command line as their own.
    .option('--dotenv <file>', 'The .env file to write the issuer into', '.env')
    .option('--var <name>', 'The variable the SDK reads the issuer from', 'PUBLIC_BRIDGE_ISSUER')
    .action(
      action(deps, async (ctx, opts: { url: string; authPath: string; dotenv: string; var: string }) => {
        const devUrl = secureUrl(opts.url);
        if (devUrl === null || devUrl.pathname !== '/' || devUrl.search !== '' || devUrl.hash !== '') {
          throw new CliError('invalid', `--url is your app's origin, https (http only on localhost), with no path: ${opts.url}`);
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.var)) throw new CliError('invalid', `--var is a variable name, such as PUBLIC_BRIDGE_ISSUER: ${opts.var}`);
        if (!opts.authPath.startsWith('/') || opts.authPath.includes('?') || opts.authPath.includes('#')) {
          throw new CliError('invalid', `--auth-path is a path on your app, such as /auth: ${opts.authPath}`);
        }
        const { c, appId } = await ctx.forApp();
        const found = await apps.get(c, appId);
        const given = found.trust?.issuer;
        // The app's issuer is on the Bridge this CLI signed in to: the project is pointed at the same server. Written as a URL
        // parser writes it, so nothing but the address reaches the file.
        const signedInTo = new URL(await ctx.issuer()).origin;
        if (typeof given !== 'string' || secureUrl(given) === null || /\s/.test(given)) throw new CliError('misconfigured', `${found.name} (${found.id}) has no issuer yet.`);
        const issuer = normalizeIssuer(given);
        if (new URL(issuer).origin !== signedInTo) {
          throw new CliError('misconfigured', `${found.name}'s issuer is on ${new URL(issuer).origin}, not on ${signedInTo}, which you signed in to.`);
        }
        const origin = devUrl.origin;
        const emailLinks = `${origin}${opts.authPath.replace(/\/+$/, '')}`;
        const wanted: [string, AddressUse][] = [[origin, 'browser-origin'], [emailLinks, 'email-links']];
        const added: { url: string; use: AddressUse }[] = [];
        let latest = found;
        for (const [url, use] of wanted) {
          if ((latest.addresses ?? []).some((each) => each.url === url && each.uses.includes(use))) continue;
          latest = await apps.addAddress(c, appId, url, [use]);
          added.push({ url, use });
        }
        const file = resolve(opts.dotenv);
        const changed = await setEnvValue(file, opts.var, issuer);
        ctx.io.info(`${changed ? 'Wrote' : 'Kept'} ${opts.var}=${issuer} in ${file}.`);
        for (const each of added) ctx.io.info(`Added ${each.url} as a ${each.use} address of ${found.name}.`);
        ctx.io.result({ app: { id: found.id, name: found.name }, issuer, envFile: file, variable: opts.var, added });
      }),
    );

  const address = app.command('address').description('The app\'s addresses: sign-in returns, email links, browser origins, sign-out and checkout returns');

  address
    .command('list')
    .description('Every address of the app and what it is used for')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        const found = await apps.get(c, appId);
        ctx.io.result({ addresses: found.addresses ?? [], defaultReturn: found.defaultReturn });
      }),
    );

  address
    .command('add <url>')
    .description('Add an address, or add uses to one the app has')
    .requiredOption('--use <use>', USES, collect)
    .action(
      action(deps, async (ctx, url: string, opts: { use: string[] }) => {
        const uses = checkUses(opts.use);
        const { c, appId } = await ctx.forApp();
        const changed = await apps.addAddress(c, appId, url, uses);
        ctx.io.result({ addresses: changed.addresses, defaultReturn: changed.defaultReturn });
      }),
    );

  address
    .command('remove <url>')
    .description('Remove an address, or only some of its uses')
    .option('--use <use>', `Only this use (${USES})`, collect)
    .action(
      action(deps, async (ctx, url: string, opts: { use?: string[] }) => {
        const uses = opts.use === undefined ? [] : checkUses(opts.use);
        const { c, appId } = await ctx.forApp();
        const changed = await apps.removeAddress(c, appId, url, uses);
        ctx.io.result({ addresses: changed.addresses, defaultReturn: changed.defaultReturn });
      }),
    );
}
