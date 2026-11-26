import type { Command } from 'commander';
import { CliError } from '../core/errors.js';
import { detectInstall, updatePlan } from '../core/install.js';
import { compareVersions, fetchLineVersion, lineOf } from '../core/updates.js';
import { action, type Deps } from './context.js';

/**
 * `bridge update`: updates the CLI on its own line (`alpha` for a prerelease, else `latest`), with the package manager
 * that installed it. When it cannot (run through npx, a project's own copy, an install it does not recognise), it prints
 * the command to run. Without a terminal it never asks: it prints the command, or runs it with `--yes`.
 */
export function registerUpdateCommands(program: Command, deps: Deps, version: string): void {
  program
    .command('update')
    .description('Update the CLI on the line you use (alpha or stable), or print the command to run when it cannot')
    .option('--yes', 'Update without asking (for scripts and coding assistants)')
    .action(
      action(deps, async (ctx, opts: { yes?: boolean }) => {
        const updates = deps.updates;
        if (updates === undefined) throw new CliError('unavailable', 'This build of the CLI cannot update itself.');
        const line = lineOf(version);
        const install = detectInstall(updates.installPath, ctx.env['npm_config_user_agent']);
        const plan = updatePlan(install, line);
        const newest = await fetchLineVersion({ registry: updates.registry, line, deadlineMs: updates.updateDeadlineMs ?? 10_000 });
        const base = { current: version, line, newest, install: install.kind, command: plan.text };

        if (newest !== null && compareVersions(version, newest) >= 0) {
          ctx.io.info(`Bridge CLI ${version} is the newest on the ${line} line.`);
          ctx.io.result({ ...base, upToDate: true, ran: false });
          return;
        }
        if (!plan.runnable) {
          ctx.io.info(`This CLI is ${plan.how}, so it does not update itself. Run: ${plan.text}`);
          ctx.io.result({ ...base, upToDate: false, ran: false });
          return;
        }
        if (!opts.yes) {
          if (!ctx.io.interactive) {
            ctx.io.info(`No terminal to confirm in. Run: ${plan.text} (or \`bridge update --yes\`)`);
            ctx.io.result({ ...base, upToDate: false, ran: false });
            return;
          }
          const answer = (await ctx.io.ask(`Update to ${newest ?? `the newest ${line}`} with \`${plan.text}\`? [Y/n] `)).trim().toLowerCase();
          if (answer !== '' && answer !== 'y' && answer !== 'yes') {
            ctx.io.result({ ...base, upToDate: false, ran: false });
            return;
          }
        }
        ctx.io.info(`Running: ${plan.text}`);
        const code = await updates.run(plan.command, plan.args);
        if (code !== 0) {
          throw new CliError('unavailable', `\`${plan.text}\` failed (exit code ${String(code)}).`, { hint: 'Run it yourself to see why; a global install may need other permissions.' });
        }
        ctx.io.info('Updated. `bridge --version` shows the version now installed.');
        ctx.io.result({ ...base, upToDate: true, ran: true });
      }),
    );
}
