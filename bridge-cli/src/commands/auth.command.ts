import type { Command } from 'commander';
import { chooseSignInPage, signInWithBrowser, signInWithPassword, type WorkspaceChoice } from '../auth/sign-in.js';
import type { StoredSession } from '../auth/store.js';
import { CliError } from '../core/errors.js';
import { action, type Context, type Deps } from './context.js';

interface Me {
  readonly id?: string;
  readonly email?: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly workspaces?: { id: string; name: string; role?: string }[];
}

async function me(ctx: Context): Promise<Me | null> {
  try {
    return (await (await ctx.client()).person<Me>('me')).body;
  } catch {
    return null;
  }
}

function summary(ctx: Context, session: StoredSession, who: Me | null, settingsApp: string | undefined) {
  return {
    issuer: session.issuer,
    workspace: session.workspace,
    user: who === null ? null : { id: who.id ?? null, email: who.email ?? null, firstName: who.firstName ?? null, lastName: who.lastName ?? null },
    app: settingsApp ?? null,
    tokenStore: ctx.sessions().describeStore(),
  };
}

/** Asks which workspace to enter, or says how to name one when nobody can be asked. */
function workspaceChooser(ctx: Context) {
  return async (choices: readonly WorkspaceChoice[]): Promise<string> => {
    if (!ctx.io.interactive) {
      throw new CliError('invalid', 'You belong to several workspaces. Name one with --workspace <id>.', {
        details: choices.map(({ id, name }) => ({ id, name })),
      });
    }
    ctx.io.info('Which workspace?');
    choices.forEach((each, i) => ctx.io.info(`  ${String(i + 1)}. ${each.name} (${each.id})`));
    const answer = (await ctx.io.ask('Number: ')).trim();
    const picked = choices[Number(answer) - 1] ?? choices.find((each) => each.id === answer);
    if (picked === undefined) throw new CliError('invalid', `No workspace ${answer}.`);
    return picked.id;
  };
}

async function readPassword(ctx: Context, fromStdin: boolean | undefined): Promise<string> {
  if (fromStdin) return (await ctx.io.readStdin()).replace(/\r?\n$/, '');
  if (!ctx.io.interactive) {
    throw new CliError('invalid', 'No terminal to ask for the password in.', { hint: 'Pipe it in with --password-stdin.' });
  }
  return ctx.io.askHidden('Password: ');
}

interface LoginOptions {
  password?: boolean;
  email?: string;
  passwordStdin?: boolean;
  workspace?: string;
  signInPage?: string;
  browser?: boolean;
}

export function registerAuthCommands(program: Command, deps: Deps): void {
  const auth = program.command('auth').description('Sign in to Bridge, sign out, and see who you are signed in as');

  auth
    .command('login')
    .description('Sign in through Bridge\'s sign-in page in your browser, or with --password in the terminal')
    .option('--password', 'Sign in with your email and password in the terminal (no browser needed)')
    .option('--email <email>', 'Your email, with --password')
    .option('--password-stdin', 'Read the password from stdin, with --password (for scripts and CI)')
    .option('--workspace <id>', 'The workspace to sign in to, when you belong to several')
    .option('--sign-in-page <url>', 'Bridge\'s sign-in page, when the issuer publishes none: only on the issuer\'s own address, or on localhost (env: BRIDGE_SIGN_IN_PAGE)')
    .option('--no-browser', 'Print the sign-in address instead of opening the browser')
    .action(
      action(deps, async (ctx, opts: LoginOptions) => {
        const issuer = await ctx.issuer();
        const d = await ctx.discovery();
        const sessions = ctx.sessions();
        let session: StoredSession;
        const issuerHost = new URL(d.issuer).host;
        if (opts.password || opts.passwordStdin) {
          // BRIDGE_ISSUER can set the issuer unseen: say where the password goes before asking for it.
          ctx.io.info(`Signing in to ${issuerHost}.`);
          const email = opts.email ?? (ctx.io.interactive ? (await ctx.io.ask('Email: ')).trim() : undefined);
          if (!email) throw new CliError('invalid', 'Give your email with --email.');
          const password = await readPassword(ctx, opts.passwordStdin);
          session = await signInWithPassword(deps.fetch, sessions, d, {
            email,
            password,
            ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
            chooseWorkspace: workspaceChooser(ctx),
          });
        } else {
          const { page, ignored } = chooseSignInPage(d, opts.signInPage ?? ctx.env['BRIDGE_SIGN_IN_PAGE']);
          if (ignored !== undefined) ctx.io.info(`Using the sign-in page ${issuerHost} publishes, not ${ignored}.`);
          ctx.io.info(`Signing in at ${new URL(page).host} for ${issuerHost}.`);
          session = await signInWithBrowser(sessions, d, {
            signInPage: page,
            openBrowser: opts.browser === false ? async () => ({ ok: false }) : deps.openBrowser,
            show: (message) => ctx.io.info(message),
            ...(deps.signInTimeoutMs === undefined ? {} : { timeoutMs: deps.signInTimeoutMs }),
          });
        }
        const saved = await ctx.config.update((settings) => {
          settings.issuer = issuer;
        });
        const who = await me(ctx);
        ctx.io.info(`Signed in${who?.email ? ` as ${who.email}` : ''}.`);
        ctx.io.result(summary(ctx, session, who, saved.apps?.[issuer]));
      }),
    );

  auth
    .command('logout')
    .description('Sign out: ends the session at Bridge and removes it from this machine')
    .action(
      action(deps, async (ctx) => {
        const issuer = await ctx.issuer();
        const sessions = ctx.sessions();
        let outcome: { revoked: boolean; reason?: string };
        try {
          outcome = await sessions.signOut(await ctx.discovery());
        } catch (error) {
          // Bridge cannot be reached: forget the session here all the same, and say it was not ended there.
          const session = await sessions.read(issuer);
          if (session === null) throw error;
          await sessions.forget(issuer);
          outcome = { revoked: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (outcome.reason !== undefined && outcome.reason !== 'not signed in') {
          ctx.io.info(`Removed the session from this machine, but Bridge could not be told: ${outcome.reason}`);
        }
        ctx.io.result({ issuer, signedOut: outcome.reason !== 'not signed in', revoked: outcome.revoked });
      }),
    );

  auth
    .command('whoami')
    .alias('status')
    .description('Who you are signed in as, in which workspace, and the app commands act on')
    .action(
      action(deps, async (ctx) => {
        const d = await ctx.discovery();
        await ctx.sessions().current(d);
        const who = (await (await ctx.client()).person<Me>('me')).body;
        // Read after the call, which may have renewed the tokens.
        const session = await ctx.sessions().current(d);
        const settings = await ctx.settings();
        ctx.io.result({ ...summary(ctx, session, who, settings.apps?.[d.issuer]), signedInAt: new Date(session.signedInAt).toISOString(), workspaces: who.workspaces ?? [] });
      }),
    );

  auth
    .command('workspace [id]')
    .description('List your workspaces, or switch the session to one of them')
    .action(
      action(deps, async (ctx, id: string | undefined) => {
        const d = await ctx.discovery();
        const sessions = ctx.sessions();
        if (id === undefined) {
          const session = await sessions.current(d);
          const who = (await (await ctx.client()).person<Me>('me')).body;
          ctx.io.result((who.workspaces ?? []).map((each) => ({ ...each, current: each.id === session.workspace })));
          return;
        }
        const renewed = await sessions.renew(d, { workspace: id });
        ctx.io.info(`Switched to workspace ${renewed.workspace ?? id}.`);
        ctx.io.result({ issuer: d.issuer, workspace: renewed.workspace });
      }),
    );
}
