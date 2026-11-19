import type { Command } from 'commander';
import { appInvites, members, roles, workspaces, type InviteFields, type Workspace } from '../api/accounts.js';
import type { Door } from '../api/door.js';
import type { BridgeClient } from '../client.js';
import { keys } from '../api/keys.js';
import { CliError } from '../core/errors.js';
import { action, type Context, type Deps } from './context.js';
import { roleDecision } from './accounts.command.js';

/**
 * The 0.x forms of the commands that team, workspace and key work moved to under new names (`tenant`, `user`, `token`,
 * `role set-default`), so a script written for 0.x keeps working: the same options (`--name` or `--id`, `--tenant-id`,
 * `--email` or `--user-id`) on the version 2 routes. A "tenant" is one of the app's workspaces, a "user" a member of one,
 * a "token" an app key. A delete answers `--dry-run` first and needs `--yes` to go ahead.
 */

const KEY_NOTE = ' (0.x form of `bridge workspace`, `bridge member`, `bridge key`)';

/** The workspace a `user` command acts in: `--tenant-id`, else `BRIDGE_TENANT_ID`. */
function tenantId(ctx: Context, given: string | undefined): string {
  const id = given ?? ctx.env['BRIDGE_TENANT_ID']?.trim();
  if (id === undefined || id === '') throw new CliError('invalid', 'Name the workspace with --tenant-id <id> or BRIDGE_TENANT_ID (`bridge tenant list` shows them).');
  return id;
}

interface Person {
  readonly id: string;
  readonly user: { readonly id: string; readonly email: string };
  readonly role: string;
  readonly status: string;
  readonly [field: string]: unknown;
}

/** A member of a workspace, by email or by user id. */
async function personIn(d: Door, workspace: string, opts: { email?: string; userId?: string }): Promise<Person> {
  if (opts.email === undefined && opts.userId === undefined) throw new CliError('invalid', 'Name the user with --email or --user-id.');
  const search = opts.email ?? undefined;
  const listed = (await members.list(d, workspace, search === undefined ? {} : { search })) as Person[];
  const found = listed.find((each) => (opts.email === undefined ? each.user.id === opts.userId || each.id === opts.userId : each.user.email.toLowerCase() === opts.email?.toLowerCase()));
  if (found === undefined) throw new CliError('not-found', `The workspace has no user ${opts.email ?? opts.userId ?? ''}.`, { hint: '`bridge user list` shows its users.' });
  return found;
}

/**
 * The workspace a `tenant` command names, by `--id`, else by `--name`, and the app it is looked up in: the command's
 * own app, with the developer's sign-in, the same way the command then acts on it, so a preview and the change it
 * shows are always about the same tenant of the same app.
 */
async function tenantOf(ctx: Context, opts: { id?: string; name?: string }): Promise<{ found: Workspace; c: BridgeClient; appId: string; door: Door }> {
  const wanted = opts.id ?? opts.name;
  if (wanted === undefined) throw new CliError('invalid', 'Name the tenant with --name or --id.');
  const { c, appId } = await ctx.forApp();
  const door: Door = { kind: 'session', c, appId };
  return { found: await workspaces.find(door, wanted), c, appId, door };
}

export function registerCompatCommands(program: Command, deps: Deps): void {
  const tenant = program.command('tenant').description(`The app's workspaces, as 0.x called them${KEY_NOTE}`);
  tenant.command('list').action(action(deps, async (ctx) => void ctx.io.result(await workspaces.list(await ctx.door()))));
  tenant
    .command('get')
    .option('--name <name>', 'The tenant\'s name (alternative to --id; must be unique)')
    .option('--id <id>', 'The tenant\'s id')
    .action(
      action(deps, async (ctx, opts: { name?: string; id?: string }) => {
        const { found, c, appId } = await tenantOf(ctx, opts);
        ctx.io.result(await workspaces.get(c, appId, found.id));
      }),
    );
  tenant
    .command('create')
    .description('Create a workspace; its owner is invited by email')
    .requiredOption('--owner-email <email>', 'The email of the person who will own it')
    .option('--name <name>', 'The tenant\'s name')
    .option('--plan <plan>', 'A plan key to put it on')
    .option('--locale <locale>', 'Its language (ISO 639-1)')
    .action(
      action(deps, async (ctx, opts: { ownerEmail: string; name?: string; plan?: string; locale?: string }) => {
        const { c, appId } = await ctx.forApp();
        const made = await workspaces.create(c, appId, { owner: { email: opts.ownerEmail }, ...(opts.name === undefined ? {} : { name: opts.name }), ...(opts.locale === undefined ? {} : { locale: opts.locale }) });
        if (opts.plan === undefined) return ctx.io.result(made);
        // The tenant stays made if the plan is refused, and the answer says so.
        try {
          await workspaces.setPlan(c, appId, made.id, { plan: opts.plan });
          ctx.io.result({ ...made, plan: opts.plan });
        } catch (error) {
          ctx.io.result({ ...made, plan: null, planNote: `The tenant was created, but putting it on plan "${opts.plan}" failed: ${error instanceof Error ? error.message : String(error)} Use \`bridge tenant set-plan\`.` });
        }
      }),
    );
  tenant
    .command('update')
    .option('--name <name>', 'The tenant to change, by its name; with --id, renames it')
    .option('--id <id>', 'The tenant\'s id')
    .option('--new-name <name>', 'Rename it')
    .option('--locale <locale>', 'Its language')
    .option('--logo <url>', 'Its logo')
    .action(
      action(deps, async (ctx, opts: { name?: string; id?: string; newName?: string; locale?: string; logo?: string }) => {
        const { found, c, appId } = opts.id !== undefined ? await tenantOf(ctx, { id: opts.id }) : await tenantOf(ctx, { name: opts.name });
        const renamed = opts.newName ?? (opts.id !== undefined ? opts.name : undefined);
        const fields = { ...(renamed === undefined ? {} : { name: renamed }), ...(opts.locale === undefined ? {} : { locale: opts.locale }), ...(opts.logo === undefined ? {} : { logo: opts.logo }) };
        if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change: give --new-name, --locale or --logo.');
        ctx.io.result(await workspaces.update(c, appId, found.id, fields));
      }),
    );
  tenant
    .command('set-plan')
    .description('Move a tenant to another plan, as the plan picker on a workspace does. Needs a recent sign-in')
    .option('--name <name>', 'The tenant, by its name')
    .option('--id <id>', 'The tenant\'s id')
    .requiredOption('--plan <key>', 'The plan key')
    .option('--interval <interval>', 'Which of the plan\'s prices: day | week | month | year')
    .option('--currency <code>', 'Which of the plan\'s prices: its currency')
    .action(
      action(deps, async (ctx, opts: { name?: string; id?: string; plan: string; interval?: string; currency?: string }) => {
        const { found, c, appId } = await tenantOf(ctx, opts);
        ctx.io.result(await workspaces.setPlan(c, appId, found.id, { plan: opts.plan, ...(opts.interval === undefined ? {} : { interval: opts.interval }), ...(opts.currency === undefined ? {} : { currency: opts.currency.toUpperCase() }) }));
      }),
    );
  tenant
    .command('delete')
    .description('Delete a tenant: it leaves every list now and is removed for good after 30 days, and an Owner can restore it until then')
    .option('--name <name>', 'The tenant, by its name')
    .option('--id <id>', 'The tenant\'s id')
    .option('--dry-run', 'Show the people who lose access and what happens, and delete nothing')
    .option('--yes', 'Confirm the deletion')
    .action(
      action(deps, async (ctx, opts: { name?: string; id?: string; dryRun?: boolean; yes?: boolean }) => {
        const { found, c, appId, door } = await tenantOf(ctx, opts);
        if (opts.dryRun) return ctx.io.result(await workspaceDeletionPreview(door, found));
        if (opts.yes !== true) throw new CliError('invalid', 'Confirm the deletion with --yes. `--dry-run` shows what it would do first.');
        ctx.io.result(await workspaces.remove(c, appId, found.id));
      }),
    );

  const user = program.command('user').description(`The people of one of the app's workspaces, as 0.x called them${KEY_NOTE}`);
  const inTenant = (cmd: Command) => cmd.option('--tenant-id <id>', 'The workspace (or set BRIDGE_TENANT_ID)');
  inTenant(user.command('list')).action(
    action(deps, async (ctx, opts: { tenantId?: string }) => {
      ctx.io.result(await members.list(await ctx.door(), tenantId(ctx, opts.tenantId)));
    }),
  );
  inTenant(user.command('get').option('--email <email>', 'The user\'s email (alternative to --user-id)').option('--user-id <id>', 'The user\'s id')).action(
    action(deps, async (ctx, opts: { tenantId?: string; email?: string; userId?: string }) => {
      const d = await ctx.door();
      const found = await personIn(d, tenantId(ctx, opts.tenantId), opts);
      ctx.io.result(await members.get(d, tenantId(ctx, opts.tenantId), found.id));
    }),
  );
  inTenant(
    user
      .command('invite')
      .description('Invite a person by email: they join with the role you name when they accept. Which role is yours to decide: without --role the command stops and asks')
      .requiredOption('--email <email>', 'The person\'s email')
      .option('--role <role>', 'A role key (`bridge role list` shows them)')
      .option('--first-name <name>', 'Their first name')
      .option('--last-name <name>', 'Their last name'),
  ).action(
    action(deps, async (ctx, opts: { tenantId?: string; email: string; role?: string; firstName?: string; lastName?: string }) => {
      const workspace = tenantId(ctx, opts.tenantId);
      if (opts.role === undefined) await roleDecision(ctx, workspace, 'bridge user invite');
      const fields: InviteFields = { email: opts.email, ...(opts.role === undefined ? {} : { role: opts.role }), ...(opts.firstName === undefined ? {} : { firstName: opts.firstName }), ...(opts.lastName === undefined ? {} : { lastName: opts.lastName }) };
      ctx.io.result(await appInvites.send(await ctx.door(), workspace, fields));
    }),
  );
  inTenant(
    user
      .command('update')
      .option('--email <email>', 'The user\'s email (alternative to --user-id)')
      .option('--user-id <id>', 'The user\'s id')
      .option('--role <role>', 'Their role key')
      .option('--enabled <bool>', 'Let them sign in (true) or stop them (false)', (value) => value === 'true'),
  ).action(
    action(deps, async (ctx, opts: { tenantId?: string; email?: string; userId?: string; role?: string; enabled?: boolean }) => {
      const d = await ctx.door();
      const workspace = tenantId(ctx, opts.tenantId);
      const found = await personIn(d, workspace, opts);
      const fields = { ...(opts.role === undefined ? {} : { role: opts.role }), ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }) };
      if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change: give --role or --enabled.');
      ctx.io.result(await members.update(d, workspace, found.id, fields));
    }),
  );
  inTenant(
    user
      .command('remove')
      .option('--email <email>', 'The user\'s email (alternative to --user-id)')
      .option('--user-id <id>', 'The user\'s id')
      .option('--dry-run', 'Say whether they are the last Owner and what goes with them, and remove nothing')
      .option('--yes', 'Confirm the removal'),
  ).action(
    action(deps, async (ctx, opts: { tenantId?: string; email?: string; userId?: string; dryRun?: boolean; yes?: boolean }) => {
      const d = await ctx.door();
      const workspace = tenantId(ctx, opts.tenantId);
      const found = await personIn(d, workspace, opts);
      if (opts.dryRun) return ctx.io.result(await memberDeletionPreview(d, workspace, found));
      if (opts.yes !== true) throw new CliError('invalid', 'Confirm the removal with --yes. `--dry-run` shows what it would do first.');
      ctx.io.result(await members.remove(d, workspace, found.id));
    }),
  );

  const token = program.command('token').description(`The app's keys, as 0.x called them${KEY_NOTE}. A key is shown once, when it is made`);
  token.command('list').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await keys.list(c, appId));
    }),
  );
  token
    .command('create')
    .description('Make a key: the secret is shown this once. Needs a recent sign-in')
    .requiredOption('--name <name>', 'What the key is for')
    .option('--privileges <list>', 'Comma-separated privilege keys', (value) => value.split(',').map((each) => each.trim()).filter((each) => each !== ''))
    .option('--expire-at <date>', 'When it expires, as an ISO date: within 365 days (default 90 days)')
    .action(
      action(deps, async (ctx, opts: { name: string; privileges?: string[]; expireAt?: string }) => {
        let expiresInDays: number | undefined;
        if (opts.expireAt !== undefined) {
          const at = new Date(opts.expireAt).getTime();
          if (Number.isNaN(at)) throw new CliError('invalid', `--expire-at is not a date: ${opts.expireAt}`);
          expiresInDays = Math.ceil((at - (deps.now?.() ?? Date.now())) / 86_400_000);
          if (expiresInDays < 1 || expiresInDays > 365) throw new CliError('invalid', '--expire-at is from 1 to 365 days from now: every key expires.');
        }
        const { c, appId } = await ctx.forApp();
        const made = await keys.create(c, appId, { name: opts.name, ...(opts.privileges === undefined ? {} : { privileges: opts.privileges }), ...(expiresInDays === undefined ? {} : { expiresInDays }) });
        ctx.io.info('The key is shown this once. Keep it in your server\'s secrets, never in code or in a browser.');
        ctx.io.result(made);
      }),
    );
  token
    .command('revoke')
    .description('Revoke a key: Bridge refuses it within seconds')
    .option('--name <name>', 'The key, by its name (alternative to --id; must be unique)')
    .option('--id <id>', 'The key\'s id')
    .option('--dry-run', 'Show its privileges and when it expires, and revoke nothing')
    .action(
      action(deps, async (ctx, opts: { name?: string; id?: string; dryRun?: boolean }) => {
        if (opts.name === undefined && opts.id === undefined) throw new CliError('invalid', 'Name the key with --name or --id.');
        const { c, appId } = await ctx.forApp();
        const listed = await keys.list(c, appId);
        const matches = listed.filter((each) => (opts.id === undefined ? each.name === opts.name : each.id === opts.id));
        if (matches.length > 1) throw new CliError('conflict', `More than one key is named "${opts.name ?? ''}".`, { hint: 'Name it by its id: `bridge key list` shows them.' });
        const found = matches[0];
        if (found === undefined) throw new CliError('not-found', `The app has no key ${opts.id ?? opts.name ?? ''}.`, { hint: '`bridge key list` shows its keys.' });
        if (opts.dryRun) {
          return ctx.io.result({
            dryRun: true,
            target: { id: found.id, name: found.name, privileges: found.privileges, expiresAt: found.expiresAt },
            sideEffects: ['Everything calling Bridge with this key is refused within seconds; there is no undo. Make a new key and put it in the server\'s secrets first.'],
          });
        }
        await keys.revoke(c, appId, found.id);
        ctx.io.result({ revoked: found.id });
      }),
    );

  program.commands
    .find((each) => each.name() === 'role')
    ?.command('set-default <role>')
    .description('Make a role the one people get when added without one named (the previous default stops being the default)')
    .action(
      action(deps, async (ctx, which: string) => {
        ctx.io.result(await roles.update(await ctx.door(), which, { isDefault: true }));
      }),
    );
}

/** What deleting a workspace does: its people, its Owners, and the 30 days. Read from the workspace's members: Accounts gives no preview of its own on the operator routes. */
async function workspaceDeletionPreview(d: Door, found: Workspace) {
  const people = (await members.list(d, found.id)) as Person[];
  const owners = people.filter((each) => each.role === 'OWNER');
  return {
    dryRun: true,
    target: { id: found.id, name: found.name },
    affects: { members: people.length, owners: owners.length, people: people.slice(0, 50).map((each) => ({ email: each.user.email, role: each.role, status: each.status })) },
    sideEffects: [
      'The deletion is scheduled, not immediate: the workspace leaves every list now and its people lose access to it.',
      'It is removed for good after 30 days; until then any Owner of the workspace can restore it.',
    ],
  };
}

/** What removing a user does: whether they are the last Owner, and that their login stays. */
async function memberDeletionPreview(d: Door, workspace: string, found: Person) {
  const people = (await members.list(d, workspace)) as Person[];
  const owners = people.filter((each) => each.role === 'OWNER' && each.status === 'active');
  const lastOwner = found.role === 'OWNER' && found.status === 'active' && owners.length <= 1;
  return {
    dryRun: true,
    target: { id: found.id, email: found.user.email, role: found.role, enabled: found.status === 'active' },
    affects: { accountDeleted: false, lastOwner },
    sideEffects: [
      'They keep their login and their other workspaces; only this membership goes, and their access to it ends within seconds.',
      ...(lastOwner ? ['They are the workspace\'s only Owner, so they cannot be removed: make someone else Owner first.'] : []),
    ],
  };
}
