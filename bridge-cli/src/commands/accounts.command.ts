import type { Command } from 'commander';
import { appInvites, invites, members, privileges, roles, workspaces, type InviteFields, type RoleFields } from '../api/accounts.js';
import { withAppKey } from '../api/keys.js';
import { CliError, isCliError } from '../core/errors.js';
import type { BridgeClient } from '../client.js';
import { action, collect, type Context, type Deps } from './context.js';

/**
 * Roles, privileges, workspaces and members: version 2 offers these routes
 * to the app's own server only, so each command runs with an app key:
 * `BRIDGE_APP_KEY`, or a one-day key the CLI makes and revokes at once.
 */
async function asApp<T>(ctx: Context, needs: string[], fn: (c: BridgeClient, key: string) => Promise<T>): Promise<T> {
  const { c, appId } = await ctx.forApp();
  return withAppKey(c, appId, needs, ctx.env, (key) => fn(c, key), { warn: (message) => ctx.io.info(message) });
}

const KEY_NOTE = ' Runs with BRIDGE_APP_KEY, or a short-lived key the CLI makes (needs a recent sign-in).';

/**
 * An invite Bridge would not send because the app has no email-links
 * address: say where to add one. For the developer's own workspace there is
 * nothing to add here, and Bridge's message stands.
 */
function withEmailLinksHint(error: unknown, appWorkspace: boolean): never {
  if (appWorkspace && isCliError(error) && error.kind === 'conflict' && /email-links/i.test(error.message)) {
    throw new CliError('conflict', error.message, {
      status: error.status,
      details: error.details,
      hint: "Add the page that opens your app's email links: `bridge app address add <url> --use email-links`.",
    });
  }
  throw error;
}

function roleFields(opts: { name?: string; description?: string; privilege?: string[]; default?: boolean }): RoleFields {
  return {
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.privilege === undefined ? {} : { privileges: opts.privilege }),
    ...(opts.default === undefined ? {} : { isDefault: opts.default }),
  };
}

export function registerAccountCommands(program: Command, deps: Deps): void {
  const role = program.command('role').description(`The app's roles and the privileges each holds.${KEY_NOTE}`);
  role.command('list').action(
    action(deps, async (ctx) => {
      ctx.io.result(await asApp(ctx, [], (c, key) => roles.list(c, key)));
    }),
  );
  role
    .command('create <key>')
    .requiredOption('--name <name>', 'The role\'s name')
    .option('--description <text>', 'What the role is for')
    .option('--privilege <privilege>', 'A privilege it holds; repeat for several', collect)
    .option('--default', 'New members get this role')
    .action(
      action(deps, async (ctx, key: string, opts: { name: string; description?: string; privilege?: string[]; default?: boolean }) => {
        ctx.io.result(await asApp(ctx, [], (c, appKey) => roles.create(c, appKey, { ...roleFields(opts), key, name: opts.name })));
      }),
    );
  role
    .command('update <role>')
    .description('Change a role, by its key or id. --privilege replaces the role\'s privileges')
    .option('--name <name>', 'The role\'s name')
    .option('--description <text>', 'What the role is for')
    .option('--privilege <privilege>', 'A privilege it holds; repeat for several', collect)
    .option('--default', 'New members get this role')
    .action(
      action(deps, async (ctx, which: string, opts: { name?: string; description?: string; privilege?: string[]; default?: boolean }) => {
        const fields = roleFields(opts);
        if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change.');
        ctx.io.result(await asApp(ctx, [], (c, key) => roles.update(c, key, which, fields)));
      }),
    );
  role.command('delete <role>').action(
    action(deps, async (ctx, which: string) => {
      ctx.io.result(await asApp(ctx, ['ROLE_DELETE'], (c, key) => roles.remove(c, key, which)));
    }),
  );

  const privilege = program.command('privilege').description(`The app's privileges, which roles hold.${KEY_NOTE}`);
  privilege.command('list').action(
    action(deps, async (ctx) => {
      ctx.io.result(await asApp(ctx, [], (c, key) => privileges.list(c, key)));
    }),
  );
  privilege
    .command('create <key>')
    .option('--description <text>', 'What it allows')
    .action(
      action(deps, async (ctx, key: string, opts: { description?: string }) => {
        ctx.io.result(await asApp(ctx, [], (c, appKey) => privileges.create(c, appKey, { key, ...(opts.description === undefined ? {} : { description: opts.description }) })));
      }),
    );
  privilege
    .command('update <privilege>')
    .option('--new-key <key>', 'Rename it')
    .option('--description <text>', 'What it allows')
    .action(
      action(deps, async (ctx, which: string, opts: { newKey?: string; description?: string }) => {
        const fields = { ...(opts.newKey === undefined ? {} : { key: opts.newKey }), ...(opts.description === undefined ? {} : { description: opts.description }) };
        if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change.');
        ctx.io.result(await asApp(ctx, [], (c, key) => privileges.update(c, key, which, fields)));
      }),
    );
  privilege.command('delete <privilege>').action(
    action(deps, async (ctx, which: string) => {
      ctx.io.result(await asApp(ctx, ['ROLE_DELETE'], (c, key) => privileges.remove(c, key, which)));
    }),
  );

  const workspace = program.command('workspace').description(`The app's workspaces (its customers' teams).${KEY_NOTE}`);
  workspace
    .command('list')
    .option('--search <text>', 'Only workspaces whose name has this')
    .option('--limit <n>', 'At most this many')
    .option('--after <cursor>', 'The page after this cursor')
    .action(
      action(deps, async (ctx, opts: { search?: string; limit?: string; after?: string }) => {
        ctx.io.result(await asApp(ctx, [], (c, key) => workspaces.list(c, key, opts)));
      }),
    );

  const member = program.command('member').description(`The members of one of the app's workspaces.${KEY_NOTE}`);
  const withWorkspace = (cmd: Command) => cmd.requiredOption('--workspace <id>', 'The workspace (`bridge workspace list` shows them)');
  withWorkspace(member.command('list'))
    .option('--search <text>', 'Only members whose name or email has this')
    .option('--limit <n>', 'At most this many')
    .option('--after <cursor>', 'The page after this cursor')
    .action(
      action(deps, async (ctx, opts: { workspace: string; search?: string; limit?: string; after?: string }) => {
        const { workspace: ws, ...query } = opts;
        ctx.io.result(await asApp(ctx, ['USER_READ'], (c, key) => members.list(c, key, ws, query)));
      }),
    );
  withWorkspace(member.command('get <member>')).action(
    action(deps, async (ctx, id: string, opts: { workspace: string }) => {
      ctx.io.result(await asApp(ctx, ['USER_READ'], (c, key) => members.get(c, key, opts.workspace, id)));
    }),
  );
  withWorkspace(member.command('update <member>'))
    .option('--role <role>', 'Give the member this role')
    .option('--disable', 'Stop the member from signing in to this workspace')
    .option('--enable', 'Let the member sign in again')
    .action(
      action(deps, async (ctx, id: string, opts: { workspace: string; role?: string; disable?: boolean; enable?: boolean }) => {
        if (opts.disable && opts.enable) throw new CliError('invalid', '--disable or --enable, not both.');
        const fields = { ...(opts.role === undefined ? {} : { role: opts.role }), ...(opts.disable ? { enabled: false } : opts.enable ? { enabled: true } : {}) };
        if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change: give --role, --disable or --enable.');
        ctx.io.result(await asApp(ctx, ['USER_WRITE'], (c, key) => members.update(c, key, opts.workspace, id, fields)));
      }),
    );
  withWorkspace(member.command('remove <member>'))
    .requiredOption('--yes', 'Confirm')
    .action(
      action(deps, async (ctx, id: string, opts: { workspace: string }) => {
        ctx.io.result(await asApp(ctx, ['USER_WRITE'], (c, key) => members.remove(c, key, opts.workspace, id)));
      }),
    );

  const invite = program
    .command('invite')
    .description(
      "Invites by email. Without --workspace, into your own workspace on Bridge (the one you signed in to), with your sign-in. " +
        "With --workspace, into one of the app's workspaces, with BRIDGE_APP_KEY or a short-lived key the CLI makes (needs a recent sign-in).",
    );
  const inWorkspace = (cmd: Command) => cmd.option('--workspace <id>', "One of the app's workspaces (`bridge workspace list` shows them); leave out for your own");
  inWorkspace(invite.command('list').description('The open invites')).action(
    action(deps, async (ctx, opts: { workspace?: string }) => {
      const ws = opts.workspace;
      if (ws === undefined) ctx.io.result(await invites.list(await ctx.client()));
      else ctx.io.result(await asApp(ctx, ['USER_READ'], (c, key) => appInvites.list(c, key, ws)));
    }),
  );
  inWorkspace(
    invite
      .command('send <email>')
      .description('Email an invite. Sending again to the same address sends a new link, and the old one stops working. An invite lasts 30 days')
      .option('--role <role>', "The role they join with; left out, the workspace's default"),
  ).action(
    action(deps, async (ctx, email: string, opts: { workspace?: string; role?: string }) => {
      const fields: InviteFields = { email, ...(opts.role === undefined ? {} : { role: opts.role }) };
      const ws = opts.workspace;
      try {
        if (ws === undefined) ctx.io.result(await invites.send(await ctx.client(), fields));
        else ctx.io.result(await asApp(ctx, ['USER_WRITE'], (c, key) => appInvites.send(c, key, ws, fields)));
      } catch (error) {
        withEmailLinksHint(error, ws !== undefined);
      }
    }),
  );
  inWorkspace(invite.command('revoke <invite>').description('Revoke an invite by its id: its link stops working')).action(
    action(deps, async (ctx, id: string, opts: { workspace?: string }) => {
      const ws = opts.workspace;
      if (ws === undefined) ctx.io.result(await invites.revoke(await ctx.client(), id));
      else ctx.io.result(await asApp(ctx, ['USER_WRITE'], (c, key) => appInvites.revoke(c, key, ws, id)));
    }),
  );
}
