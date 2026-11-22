import type { Command } from 'commander';
import { signInSettings, type LeakedPasswords, type SignUpProtection } from '../api/settings.js';
import { byText, domainBlocks, domainOf, flaggedSignUps, REASONS, users, workspaceDomainBlocks, workspaceLimit, type AppUser } from '../api/security.js';
import { CliError } from '../core/errors.js';
import type { BridgeClient } from '../client.js';
import { action, type Deps } from './context.js';

/**
 * Login security: suspend and resume a person with a reason, blocked email domains (the app's, or one workspace's),
 * Sign-up protection and its flagged sign-ups, leaked passwords and admin notices, and how many workspaces one person can
 * create. Each setting without a value shows what it is now.
 */

const choose = <T extends string>(value: string, name: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new CliError('invalid', `${name} is ${allowed.join(', ')}: ${value}`);
  return value as T;
};

/** A person by email or user id: the id a suspension is made on. */
async function userOf(c: BridgeClient, appId: string, opts: { email?: string; userId?: string }): Promise<{ id: string; email: string | null }> {
  if ((opts.email === undefined) === (opts.userId === undefined)) throw new CliError('invalid', 'Name the person with --email or --user-id.');
  if (opts.userId !== undefined) return { id: opts.userId.trim(), email: null };
  const given = (opts.email as string).trim();
  const found = await users.byEmail(c, appId, given);
  if (found === null) throw new CliError('not-found', `The app has no user with the email ${given}.`);
  return { id: found.id, email: found.email };
}

/** A person as shown: whether they are suspended, and who did it, when and why. */
function userView(user: AppUser) {
  const s = user.suspension ?? null;
  return {
    id: user.id,
    email: user.email,
    suspended: user.suspended,
    ...(s === null ? {} : { suspension: { by: byText(s.by), at: s.at, reason: s.reason, ...(s.viaDomain === null ? {} : { viaDomain: s.viaDomain }) } }),
    ...(user.workspaces === undefined ? {} : { workspaces: user.workspaces }),
  };
}

export function registerSecurityCommands(program: Command, deps: Deps): void {
  // The `user` group is the compat commands' (the people of one workspace): suspending is across the whole app.
  const user = program.commands.find((each) => each.name() === 'user') as Command;
  const person = (cmd: Command) => cmd.option('--email <email>', "The person's email (alternative to --user-id)").option('--user-id <id>', "The person's user id");
  person(user.command('suspension').description('Whether a person is suspended across the app, and who suspended them, when and why')).action(
    action(deps, async (ctx, opts: { email?: string; userId?: string }) => {
      const { c, appId } = await ctx.forApp();
      if (opts.email === undefined) throw new CliError('invalid', 'Name the person with --email.');
      const found = await users.byEmail(c, appId, opts.email.trim());
      if (found === null) throw new CliError('not-found', `The app has no user with the email ${opts.email}.`);
      ctx.io.result(userView(found));
    }),
  );
  person(user.command('suspend').description('Suspend a person across every workspace of the app: every sign-in and token of theirs is refused within seconds. Nothing of theirs is deleted'))
    .option('--reason <text>', 'Why: admins can read it, with who and when; the person cannot (at most 500 characters)')
    .action(
      action(deps, async (ctx, opts: { email?: string; userId?: string; reason?: string }) => {
        if (opts.reason !== undefined && opts.reason.length > 500) throw new CliError('invalid', '--reason is at most 500 characters.');
        const { c, appId } = await ctx.forApp();
        const who = await userOf(c, appId, opts);
        const reason = opts.reason === undefined || opts.reason.trim() === '' ? undefined : opts.reason.trim();
        const done = await users.suspend(c, appId, who.id, reason);
        ctx.io.result({ ...userView({ ...done, email: done.email ?? who.email ?? '' }), changed: true });
      }),
    );
  person(user.command('resume').description('Let a suspended person sign in again')).action(
    action(deps, async (ctx, opts: { email?: string; userId?: string }) => {
      const { c, appId } = await ctx.forApp();
      const who = await userOf(c, appId, opts);
      const done = await users.resume(c, appId, who.id);
      ctx.io.result({ ...userView({ ...done, email: done.email ?? who.email ?? '' }), changed: true });
    }),
  );

  const domain = program.command('domain').description('Blocked email domains. Nobody can sign up with an address on a blocked domain. Other domains and other apps are not affected');
  const withWorkspace = (cmd: Command) => cmd.option('--workspace <id>', 'The workspace\'s own list instead of the app\'s: people on the domain cannot join that workspace (`bridge workspace list` shows them)');
  withWorkspace(domain.command('list').description('The blocked domains, with who blocked each, when and why')).action(
    action(deps, async (ctx, opts: { workspace?: string }) => {
      const { c, appId } = await ctx.forApp();
      const list = opts.workspace === undefined ? await domainBlocks.list(c, appId) : await workspaceDomainBlocks.list(c, appId, opts.workspace);
      ctx.io.result({ ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }), blocked: list.map((each) => ({ ...each, by: byText(each.by) })) });
    }),
  );
  withWorkspace(domain.command('block <domain>').description('Block a domain (or the domain of an email address). On the app\'s list it says how many people are on it first'))
    .option('--reason <text>', 'Why (at most 500 characters)')
    .option('--suspend-existing', 'Also suspend the people already on the domain (the app\'s list only)')
    .action(
      action(deps, async (ctx, typed: string, opts: { workspace?: string; reason?: string; suspendExisting?: boolean }) => {
        const name = domainOf(typed);
        if (opts.reason !== undefined && opts.reason.length > 500) throw new CliError('invalid', '--reason is at most 500 characters.');
        const reason = opts.reason === undefined || opts.reason.trim() === '' ? {} : { reason: opts.reason.trim() };
        const { c, appId } = await ctx.forApp();
        if (opts.workspace !== undefined) {
          if (opts.suspendExisting === true) throw new CliError('invalid', '--suspend-existing is for the app\'s list: a workspace\'s list never suspends anyone.');
          const list = await workspaceDomainBlocks.add(c, appId, opts.workspace, { domain: name, ...reason });
          ctx.io.result({ workspace: opts.workspace, blocked: list.map((each) => ({ ...each, by: byText(each.by) })), changed: true });
          return;
        }
        const preview = await domainBlocks.preview(c, appId, name);
        if (preview.users === 0) ctx.io.info(`Nobody in this app uses ${name} yet.`);
        else {
          ctx.io.info(`${String(preview.users)} ${preview.users === 1 ? 'person' : 'people'} in this app use ${name}; ${String(preview.active)} not suspended yet.`);
          ctx.io.info(opts.suspendExisting === true ? `${String(preview.active)} will be suspended and signed out within seconds.` : 'They keep their access. Add --suspend-existing to suspend them too.');
        }
        const done = await domainBlocks.add(c, appId, { domain: name, ...reason, suspendExisting: opts.suspendExisting === true });
        ctx.io.result({ domain: done.domain, peopleOnDomain: preview.users, suspended: done.suspended, changed: true });
      }),
    );
  withWorkspace(domain.command('unblock <domain>').description('Unblock a domain. People it suspended stay suspended until you resume them')).action(
    action(deps, async (ctx, typed: string, opts: { workspace?: string }) => {
      const name = domainOf(typed);
      const { c, appId } = await ctx.forApp();
      if (opts.workspace === undefined) {
        ctx.io.result({ ...(await domainBlocks.remove(c, appId, name)), changed: true });
        return;
      }
      const list = await workspaceDomainBlocks.remove(c, appId, opts.workspace, name);
      ctx.io.result({ workspace: opts.workspace, blocked: list.map((each) => ({ ...each, by: byText(each.by) })), changed: true });
    }),
  );

  const workspace = program.commands.find((each) => each.name() === 'workspace') as Command;
  workspace
    .command('limit [number]')
    .description('How many workspaces one person can create of their own: a whole number from 1, or "none" for no limit. Without a value it shows the setting. Joining by invite is never limited')
    .action(
      action(deps, async (ctx, value: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        if (value === undefined) {
          ctx.io.result(await workspaceLimit.get(c, appId));
          return;
        }
        const wanted = value === 'none' ? null : Number(value);
        if (wanted !== null && !(Number.isInteger(wanted) && wanted >= 1 && /^\d{1,6}$/.test(value))) throw new CliError('invalid', `The limit is a whole number from 1, or none: ${value}`);
        ctx.io.result({ ...(await workspaceLimit.set(c, appId, wanted)), changed: true });
      }),
    );

  const auth = program.commands.find((each) => each.name() === 'auth') as Command;
  auth
    .command('sign-up-protection [mode]')
    .description('Find bots and throwaway addresses among new sign-ups: off | watch (mark them, stop nobody; the default) | block (refuse them). Without a value it shows the setting')
    .action(
      action(deps, async (ctx, mode: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        if (mode === undefined) {
          ctx.io.result({ signUpProtection: (await signInSettings.get(c, appId)).signUpProtection ?? 'watch' });
          return;
        }
        const changed = await signInSettings.update(c, appId, { signUpProtection: choose<SignUpProtection>(mode, 'The mode', ['off', 'watch', 'block']) });
        ctx.io.result({ signUpProtection: changed.signUpProtection ?? mode, changed: true });
      }),
    );
  auth
    .command('flagged-sign-ups')
    .description('The sign-ups Sign-up protection flagged, newest first, with score and reasons. A score of 60 or more is refused on Block')
    .option('--limit <n>', 'At most this many on a page (default 50, at most 200)')
    .option('--min-score <n>', 'Only scores from this (1 to 100)')
    .option('--after <cursor>', 'The page after this cursor (the "next" of the last page)')
    .action(
      action(deps, async (ctx, opts: { limit?: string; minScore?: string; after?: string }) => {
        const { c, appId } = await ctx.forApp();
        const page = await flaggedSignUps.list(c, appId, { limit: opts.limit, minScore: opts.minScore, after: opts.after });
        ctx.io.result({
          signUps: page.signUps.map((each) => ({ email: each.email, user: each.user, score: each.signUpRisk?.score ?? 0, reasons: (each.signUpRisk?.reasons ?? []).map((reason) => REASONS[reason] ?? reason), signedUpAt: each.signedUpAt })),
          next: page.next,
        });
      }),
    );
  auth
    .command('leaked-passwords [mode]')
    .description('What happens to a password found in a public leak: warn (they may go on after confirming; the default) | refuse. Without a value it shows the setting')
    .action(
      action(deps, async (ctx, mode: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        if (mode === undefined) {
          ctx.io.result({ leakedPasswords: (await signInSettings.get(c, appId)).leakedPasswords ?? 'warn' });
          return;
        }
        const changed = await signInSettings.update(c, appId, { leakedPasswords: choose<LeakedPasswords>(mode, 'The mode', ['warn', 'refuse']) });
        ctx.io.result({ leakedPasswords: changed.leakedPasswords ?? mode, changed: true });
      }),
    );
  auth
    .command('admin-notices [on|off]')
    .description('A daily summary for your admins of leaked passwords and suspicious sign-ups, sent when there is something to report. Nobody is named. Without a value it shows the setting')
    .action(
      action(deps, async (ctx, value: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        if (value === undefined) {
          ctx.io.result({ adminNotices: (await signInSettings.get(c, appId)).adminNotices ?? false });
          return;
        }
        const on = choose(value, 'The value', ['on', 'off']) === 'on';
        const changed = await signInSettings.update(c, appId, { adminNotices: on });
        ctx.io.result({ adminNotices: changed.adminNotices ?? on, changed: true });
      }),
    );
}
