import type { Command } from 'commander';
import { ADDRESS_USES, apps, checkUses, type AppFields } from '../api/apps.js';
import { CliError } from '../core/errors.js';
import { action, collect, type Deps } from './context.js';

interface ProfileOptions {
  name?: string;
  logo?: string;
  website?: string;
  privacyPolicy?: string;
  termsOfService?: string;
}

/** The profile fields given; "none" clears one. */
function profile(opts: ProfileOptions): AppFields {
  const fields: Record<string, string | null> = {};
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
    .option('--terms-of-service <url>', 'Terms of service ("none" clears it)');

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
        ctx.io.result((await apps.list(c)).map((each) => ({ ...each, current: each.id === current })));
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
      if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change: give --name, --logo, --website, --privacy-policy or --terms-of-service.');
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
