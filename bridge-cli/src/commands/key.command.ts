import { InvalidArgumentError, type Command } from 'commander';
import { keys } from '../api/keys.js';
import { action, collect, type Deps } from './context.js';

function days(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new InvalidArgumentError('A whole number of days from 1 to 365.');
  return n;
}

export function registerKeyCommands(program: Command, deps: Deps): void {
  const key = program.command('key').description('App keys: what the app\'s own server calls Bridge with');

  key
    .command('list')
    .description('The app\'s keys (never their secrets)')
    .action(
      action(deps, async (ctx) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await keys.list(c, appId));
      }),
    );

  key
    .command('create')
    .description('Make an app key. The secret is shown this once: put it in your server\'s secrets. Needs a recent sign-in')
    .requiredOption('--name <name>', 'What the key is for, such as "production server"')
    .option('--privilege <privilege>', 'A privilege the key holds; repeat for several', collect)
    .option('--expires-in-days <days>', 'Days until it expires, 1 to 365 (default 90)', days)
    .action(
      action(deps, async (ctx, opts: { name: string; privilege?: string[]; expiresInDays?: number }) => {
        const { c, appId } = await ctx.forApp();
        const made = await keys.create(c, appId, {
          name: opts.name,
          ...(opts.privilege === undefined ? {} : { privileges: opts.privilege }),
          ...(opts.expiresInDays === undefined ? {} : { expiresInDays: opts.expiresInDays }),
        });
        ctx.io.info('The key is shown this once. Keep it in your server\'s secrets, never in code or in a browser.');
        ctx.io.result(made);
      }),
    );

  key
    .command('revoke <id>')
    .description('Revoke a key: Bridge refuses it within seconds')
    .action(
      action(deps, async (ctx, id: string) => {
        const { c, appId } = await ctx.forApp();
        await keys.revoke(c, appId, id);
        ctx.io.result({ revoked: id });
      }),
    );
}
