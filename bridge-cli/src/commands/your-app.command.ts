import type { Command } from 'commander';
import { apps, type App, type AppMode, type ModeAnswer, type ProductionStatus, type Rule, type SignInLocation } from '../api/apps.js';
import { CliError } from '../core/errors.js';
import type { BridgeClient } from '../client.js';
import { action, type Deps } from './context.js';

/**
 * The "Your app" settings and the mode: the main address with the passkeys a move would stop, where
 * users sign in, and development or production with the rules production keeps on. Each asks Bridge, which checks
 * everything again; what is checked here is only so a refusal comes with the number the developer needs.
 */

const PASSWORD_RULE = 'password-rules-at-least-recommended';

/** One rule as shown: whether it holds, or why it is not known here. */
export interface RuleLine {
  readonly rule: string;
  readonly text: string;
  /** true or false; null when it is checked only when users sign in (the password rule, when its status could not be read). */
  readonly passes: boolean | null;
  readonly note?: string;
}

/** The rules the App registry decides, and the password rule from Identity and Access when it answered (else "checked when users sign in"). */
export function ruleLines(rules: readonly Rule[], production: ProductionStatus | null): RuleLine[] {
  return rules.map((rule) => {
    const passes = rule.rule === PASSWORD_RULE && rule.passes === null && production !== null ? production.passwordRules.passes : rule.passes;
    return passes === null ? { ...rule, passes, note: 'Checked when users sign in' } : { ...rule, passes };
  });
}

async function productionOrNull(c: BridgeClient, appId: string): Promise<ProductionStatus | null> {
  try {
    return await apps.production(c, appId);
  } catch {
    return null;
  }
}

/** What the mode answer, with the password rule and the number of users, comes to for one app. */
function modeReport(mode: ModeAnswer, production: ProductionStatus | null) {
  return {
    mode: mode.mode,
    main: mode.main,
    rules: ruleLines(mode.rules, production),
    usersToChooseNewPassword: production?.usersToChooseNewPassword ?? null,
    canSwitchToProduction: mode.canSwitchToProduction && ruleLines(mode.rules, production).every((line) => line.passes !== false),
  };
}

const yourAppOf = (app: App) => app.yourApp ?? null;

export function registerYourAppCommands(app: Command, deps: Deps): void {
  app
    .command('main [origin]')
    .description('Show the app\'s main address, or move it to another listed address. Passkeys belong to its domain')
    .option('--confirm-passkeys', 'Go ahead although passkeys made for the old domain stop working')
    .action(
      action(deps, async (ctx, origin: string | undefined, opts: { confirmPasskeys?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        const found = await apps.get(c, appId);
        const yours = yourAppOf(found);
        if (origin === undefined) {
          ctx.io.result({ main: yours?.main ?? null, passkeyDomain: yours?.passkeyDomain ?? null, choices: yours?.mainChoices ?? [] });
          return;
        }
        if (yours?.main === origin) {
          ctx.io.info(`${origin} is the main address already.`);
          ctx.io.result({ main: origin, passkeyDomain: yours.passkeyDomain, changed: false });
          return;
        }
        // The passkeys that stop working are shown before anything is changed, as the server's own refusal asks for.
        const impact = await apps.passkeyImpact(c, appId, origin);
        const moves = impact.from !== null && impact.from !== impact.to;
        if (moves) {
          ctx.io.info(`Passkeys belong to the main address's domain: moving it from ${impact.from} to ${impact.to} stops ${impact.stopWorking} passkey${impact.stopWorking === 1 ? '' : 's'} made for ${impact.from}.`);
          if (opts.confirmPasskeys !== true) {
            throw new CliError('conflict', `${impact.stopWorking} passkey${impact.stopWorking === 1 ? '' : 's'} would stop working. Nothing was changed.`, { hint: 'Run it again with --confirm-passkeys to go ahead.', details: impact });
          }
        }
        const changed = await apps.update(c, appId, { main: origin, ...(moves ? { confirmPasskeys: true } : {}) });
        ctx.io.result({ main: yourAppOf(changed)?.main ?? origin, passkeyDomain: yourAppOf(changed)?.passkeyDomain ?? impact.to, changed: true, passkeysStopped: moves ? impact.stopWorking : 0 });
      }),
    );

  app
    .command('related-origins')
    .description("Passkeys on the app's other domains and on Bridge's sign-in page (related origins): show them, change them, or check the file the main domain publishes. Needs an https main address")
    .option('--add <origin>', 'Let another https address of the app use the passkeys (repeatable)', (value: string, all: string[] = []) => [...all, value])
    .option('--remove <origin>', 'Stop letting an address use them (repeatable)', (value: string, all: string[] = []) => [...all, value])
    .option('--hosted <on|off>', "Use passkeys directly on Bridge's sign-in page")
    .option('--none', 'Remove every related origin')
    .option('--check', 'Read the main domain\'s /.well-known/webauthn now and keep what was found')
    .action(
      action(deps, async (ctx, opts: { add?: string[]; remove?: string[]; hosted?: string; none?: boolean; check?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        let found = await apps.get(c, appId);
        const now = yourAppOf(found)?.relatedOrigins ?? null;
        if (opts.none === true || opts.add !== undefined || opts.remove !== undefined || opts.hosted !== undefined) {
          if (opts.hosted !== undefined && !['on', 'off'].includes(opts.hosted)) throw new CliError('invalid', '--hosted is on or off. Nothing was changed.');
          const origins = [...new Set([...(now?.origins ?? []).filter((each) => !(opts.remove ?? []).includes(each)), ...(opts.add ?? [])])];
          const hosted = opts.hosted === undefined ? (now?.hosted ?? false) : opts.hosted === 'on';
          found = await apps.update(c, appId, { relatedOrigins: opts.none === true || (origins.length === 0 && !hosted) ? null : { origins, hosted } });
        }
        if (opts.check === true) found = await apps.checkRelatedOrigins(c, appId);
        const related = yourAppOf(found)?.relatedOrigins ?? null;
        if (related?.file) ctx.io.info(`Publish at ${related.file.url} (application/json):\n${JSON.stringify(related.file.body, null, 2)}`);
        ctx.io.result({
          relatedOrigins: related === null ? null : { origins: related.origins, hosted: related.hosted, file: related.file, check: related.check, limit: `at most ${related.labelLimit} different domain names` },
        });
      }),
    );

  app
    .command('sign-in')
    .description('Where users sign in (in your app, or on Bridge\'s pages) and the paths under Advanced. Without options it shows them')
    .option('--location <where>', 'app | hosted: where signed-out users go, where email links open and where users land after signing out')
    .option('--path <path>', 'Your sign-in page, such as /auth/login')
    .option('--return-path <path>', 'Where Google or company sign-in returns to, such as /auth/oauth-callback (valid on every address)')
    .option('--email-links <where>', 'app | hosted | default: where links in emails open ("default" follows --location)')
    .action(
      action(deps, async (ctx, opts: { location?: string; path?: string; returnPath?: string; emailLinks?: string }) => {
        const { c, appId } = await ctx.forApp();
        const choose = (value: string | undefined, name: string, extra: readonly string[] = []) => {
          if (value !== undefined && !['app', 'hosted', ...extra].includes(value)) throw new CliError('invalid', `${name} is ${['app', 'hosted', ...extra].join(' or ')}: ${value}`);
        };
        choose(opts.location, '--location');
        choose(opts.emailLinks, '--email-links', ['default']);
        const signIn = {
          ...(opts.location === undefined ? {} : { location: opts.location as SignInLocation }),
          ...(opts.path === undefined ? {} : { path: opts.path }),
          ...(opts.returnPath === undefined ? {} : { returnPath: opts.returnPath }),
          ...(opts.emailLinks === undefined ? {} : { emailLinks: opts.emailLinks === 'default' ? null : (opts.emailLinks as SignInLocation) }),
        };
        const found = Object.keys(signIn).length === 0 ? await apps.get(c, appId) : await apps.update(c, appId, { signIn });
        ctx.io.result({ signIn: yourAppOf(found)?.signIn ?? null });
      }),
    );

  app
    .command('mode [mode]')
    .description('Show whether the app is in development or production and what production keeps on, or switch it (development | production)')
    .option('--yes', 'Confirm the switch')
    .action(
      action(deps, async (ctx, to: string | undefined, opts: { yes?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        if (to !== undefined && to !== 'development' && to !== 'production') throw new CliError('invalid', `The mode is development or production: ${to}`);
        const before = modeReport(await apps.mode(c, appId), await productionOrNull(c, appId));
        if (to === undefined) {
          ctx.io.result(before);
          return;
        }
        if (to === before.mode) {
          ctx.io.info(`The app is in ${to} already.`);
          ctx.io.result(before);
          return;
        }
        for (const line of before.rules) ctx.io.info(`${line.passes === true ? 'ok     ' : line.passes === false ? 'failing' : 'unknown'}  ${line.text}${line.note === undefined ? '' : ` (${line.note})`}`);
        if (to === 'production') {
          const failing = before.rules.filter((line) => line.passes === false);
          if (failing.length > 0) {
            throw new CliError('conflict', `The app can go to production once: ${failing.map((line) => line.text).join('; ')}. Nothing was changed.`, {
              hint: 'Set a main address that is a real website with `bridge app main <origin>`, and password rules at least Recommended, then try again.',
              details: before,
            });
          }
          if (before.usersToChooseNewPassword !== null && before.usersToChooseNewPassword > 0) {
            ctx.io.info(`${before.usersToChooseNewPassword} user${before.usersToChooseNewPassword === 1 ? '' : 's'} with a password that breaks the production rules must choose a new one at their next sign-in.`);
          }
        } else {
          ctx.io.info('Development lets you loosen the safety rules while you build. Your users will not notice the switch; nothing is loosened until you change a rule.');
        }
        if (opts.yes !== true) throw new CliError('invalid', `Switching to ${to} needs a confirmation. Nothing was changed.`, { hint: `Run \`bridge app mode ${to} --yes\` to switch.` });
        await apps.switchMode(c, appId, to as AppMode);
        const after = modeReport(await apps.mode(c, appId), await productionOrNull(c, appId));
        ctx.io.result({ ...after, switched: { from: before.mode, to } });
      }),
    );
}
