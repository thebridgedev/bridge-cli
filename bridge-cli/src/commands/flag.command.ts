import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { FLAG_STATES, VALUE_TYPES, flags, parseCondition, parseRule, parseValue, type Flag, type FlagFields, type FlagState, type Rule, type ValueType } from '../api/flags.js';
import { evaluateFlag } from '../flag-evaluator/evaluate.js';
import type { EvaluationContext, FlagDefinition, SegmentDefinition } from '../flag-evaluator/model.js';
import { apps } from '../api/apps.js';
import { CliError } from '../core/errors.js';
import { action, collect, type Context, type Deps } from './context.js';

function oneOf<T extends string>(list: readonly T[], what: string) {
  return (value: string): T => {
    if (!(list as readonly string[]).includes(value)) throw new InvalidArgumentError(`${what} is one of ${list.join(', ')}.`);
    return value as T;
  };
}

function percent(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new InvalidArgumentError('A share from 0 to 100.');
  return n;
}

async function ruleFrom(opts: { rule?: string; ruleFile?: string }): Promise<Rule | undefined> {
  if (opts.rule !== undefined && opts.ruleFile !== undefined) throw new CliError('invalid', 'Give the rule with --rule or --rule-file, not both.');
  if (opts.rule !== undefined) return parseRule(opts.rule);
  if (opts.ruleFile !== undefined) return parseRule(await readFile(opts.ruleFile, 'utf8'));
  return undefined;
}

interface FlagOptions {
  description?: string;
  type?: ValueType;
  onValue?: string;
  offValue?: string;
  state?: FlagState;
  rule?: string;
  ruleFile?: string;
  when?: string[];
  rollout?: number;
  public?: boolean;
}

const withFlagOptions = (cmd: Command) =>
  cmd
    .option('--description <text>', 'What the flag gates')
    .option('--on-value <value>', 'The value while it is on (default true)')
    .option('--off-value <value>', 'The value while it is off (default false)')
    .option('--state <state>', `${FLAG_STATES.join(' | ')}`, oneOf(FLAG_STATES, '--state'))
    .option('--rule <json>', 'The rule as JSON: { "branches": [...], "otherwiseValue": … }')
    .option('--rule-file <file>', 'The rule from a JSON file')
    .option('--when <condition>', 'A condition of a one-branch rule, "<attribute> <operator> <value>", such as "privileges contains USER_WRITE"; repeat to AND them', collect)
    .option('--rollout <percent>', 'With --when: only this share of the people it matches', percent)
    .option('--public', 'Visitors who are not signed in may read it');

/** A one-branch rule from `--when` conditions: matches give the on value, everyone else the off value. */
function whenRule(conditions: string[], onValue: unknown, offValue: unknown, rollout: number | undefined): Rule {
  return {
    branches: [{ conditions: conditions.map(parseCondition), returnValue: onValue, ...(rollout === undefined ? {} : { rolloutPct: rollout }) }],
    otherwiseValue: offValue,
  };
}

async function ruleOption(opts: FlagOptions, onValue: unknown, offValue: unknown): Promise<Rule | undefined> {
  const given = await ruleFrom(opts);
  if (opts.when !== undefined) {
    if (given !== undefined) throw new CliError('invalid', 'Give the rule with --when or with --rule / --rule-file, not both.');
    return whenRule(opts.when, onValue, offValue, opts.rollout);
  }
  if (opts.rollout !== undefined) throw new CliError('invalid', '--rollout goes with --when.');
  return given;
}

/** The state a rule change leaves the flag in: the rule runs, unless the flag is switched off. */
function stateWithRule(flag: Flag): FlagState {
  return flag.state === 'off' ? 'off' : 'on-with-rule';
}

function noteIfOff(ctx: Context, flag: Flag): void {
  if (flag.state === 'off') ctx.io.info(`${flag.key} is off, so its rule does not run yet. \`bridge flag restore ${flag.key}\` or \`bridge flag update ${flag.key} --state on-with-rule\` turns it on.`);
}

export function registerFlagCommands(program: Command, deps: Deps): void {
  const flag = program.command('flag').description('Feature flags and their rules: every gate in app code is a flag');

  flag.command('list').description('The app\'s flags').action(
    action(deps, async (ctx) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.list(c, appId));
    }),
  );

  flag.command('get <key>').description('One flag, with its rule').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.get(c, appId, key));
    }),
  );

  withFlagOptions(flag.command('create <key>').description('Create a flag').option('--type <type>', `The values' type: ${VALUE_TYPES.join(' | ')} (default boolean)`, oneOf(VALUE_TYPES, '--type'))).action(
    action(deps, async (ctx, key: string, opts: FlagOptions) => {
      const type = opts.type ?? 'boolean';
      const onValue = opts.onValue === undefined ? (type === 'boolean' ? true : undefined) : parseValue(opts.onValue, type);
      const offValue = opts.offValue === undefined ? (type === 'boolean' ? false : undefined) : parseValue(opts.offValue, type);
      if (onValue === undefined || offValue === undefined) throw new CliError('invalid', `A ${type} flag needs --on-value and --off-value.`);
      const rule = await ruleOption(opts, onValue, offValue);
      const fields: FlagFields & { key: string } = {
        key,
        valueType: type,
        onValue,
        offValue,
        state: opts.state ?? (rule === undefined ? 'off' : 'on-with-rule'),
        ...(rule === undefined ? {} : { rule }),
        ...(opts.description === undefined ? {} : { description: opts.description }),
        ...(opts.public === undefined ? {} : { public: opts.public }),
      };
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.create(c, appId, fields));
    }),
  );

  withFlagOptions(flag.command('update <key>').description('Change a flag').option('--new-key <key>', 'Rename it').option('--private', 'Only signed-in people may read it')).action(
    action(deps, async (ctx, key: string, opts: FlagOptions & { newKey?: string; private?: boolean }) => {
      const given = await ruleFrom(opts);
      if (opts.when !== undefined && given !== undefined) throw new CliError('invalid', 'Give the rule with --when or with --rule / --rule-file, not both.');
      if (opts.rollout !== undefined && opts.when === undefined) throw new CliError('invalid', '--rollout goes with --when.');
      const { c, appId } = await ctx.forApp();
      const changed = await flags.update(c, appId, key, (current) => {
        const onValue = opts.onValue === undefined ? current.onValue : parseValue(opts.onValue, current.valueType);
        const offValue = opts.offValue === undefined ? current.offValue : parseValue(opts.offValue, current.valueType);
        const rule = opts.when === undefined ? given : whenRule(opts.when, onValue, offValue, opts.rollout);
        const fields: FlagFields = {
          ...(opts.newKey === undefined ? {} : { key: opts.newKey }),
          ...(opts.description === undefined ? {} : { description: opts.description }),
          ...(opts.onValue === undefined ? {} : { onValue }),
          ...(opts.offValue === undefined ? {} : { offValue }),
          ...(opts.public ? { public: true } : opts.private ? { public: false } : {}),
          ...(rule === undefined ? {} : { rule }),
        };
        const state = opts.state ?? (rule === undefined ? undefined : stateWithRule(current));
        if (state !== undefined) fields.state = state;
        if (Object.keys(fields).length === 0) throw new CliError('invalid', 'Nothing to change.');
        return fields;
      });
      if (given !== undefined || opts.when !== undefined) noteIfOff(ctx, changed);
      ctx.io.result(changed);
    }),
  );

  flag.command('on <key>').description('Everyone gets the on value').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.update(c, appId, key, { state: 'on' }));
    }),
  );

  flag.command('off <key>').description('Switch the flag off (the kill switch). Its rule is kept, and `restore` brings it back').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.kill(c, appId, key));
    }),
  );

  flag.command('restore <key>').description('Undo `off`: the flag goes back to what it was').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.restore(c, appId, key));
    }),
  );

  flag
    .command('delete <key>')
    .description('Delete the flag, its rule and its schedule')
    .option('--yes', 'Confirm')
    .option('--dry-run', 'Say what deleting it would do, and delete nothing')
    .action(
      action(deps, async (ctx, key: string, opts: { yes?: boolean; dryRun?: boolean }) => {
        const { c, appId } = await ctx.forApp();
        if (opts.dryRun) return ctx.io.result(await flags.deletionPreview(c, appId, key));
        if (opts.yes !== true) throw new CliError('invalid', `Confirm the deletion with --yes. \`bridge flag delete ${key} --dry-run\` says what it would do first.`);
        ctx.io.result(await flags.remove(c, appId, key));
      }),
    );

  flag
    .command('toggle <key>')
    .description('Switch the flag on or off, as 0.x did: --enabled true is `flag on`, --enabled false is the state off')
    .requiredOption('--enabled <bool>', 'true = state on, false = state off', (value) => value === 'true')
    .action(
      action(deps, async (ctx, key: string, opts: { enabled: boolean }) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await flags.update(c, appId, key, { state: opts.enabled ? 'on' : 'off' }));
      }),
    );

  flag
    .command('eval <key>')
    .description('What the flag gives someone, worked out here from its rule and the app\'s segments: nothing is sent to Bridge but the reads')
    .option('--context <json>', 'The facts, as a JSON object: {"user.role":"ADMIN","bridge:billing.entitlement.analytics":true}')
    .option('--identity <id>', 'Who it is for: what a share of people is counted by (the targeting key). Needed when the rule gives a share under 100')
    .action(
      action(deps, async (ctx, key: string, opts: { context?: string; identity?: string }) => {
        let attributes: Record<string, unknown> = {};
        if (opts.context !== undefined) {
          try {
            const parsed: unknown = JSON.parse(opts.context);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
            attributes = parsed as Record<string, unknown>;
          } catch (error) {
            throw new CliError('invalid', `--context is a JSON object: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const { c, appId } = await ctx.forApp();
        const found = await flags.get(c, appId, key);
        const segments = new Map(((await flags.segments(c, appId)) as SegmentDefinition[]).map((each) => [each.key, each]));
        const context: EvaluationContext = { ...attributes, ...(opts.identity === undefined ? {} : { targetingKey: opts.identity }) };
        const result = evaluateFlag(found as unknown as FlagDefinition, context, { segments });
        const warnings: string[] = [];
        if (result.reason === 'ERROR') warnings.push(`The rule could not be evaluated: ${result.errorDetails ?? result.errorCode ?? 'GENERAL'}.`);
        if (found.state === 'on-with-rule' && found.rule === null) warnings.push('The state is on-with-rule but there is no rule: the flag is effectively always on.');
        ctx.io.result({
          flag: found.key,
          state: found.state,
          valueType: found.valueType,
          context: { identity: opts.identity ?? null, attributes },
          enabled: found.valueType === 'boolean' ? Boolean(result.value) : result.matched,
          value: result.value,
          result: { value: result.value, variant: result.variant, reason: result.reason, variantIndex: result.variantIndex, matched: result.matched },
          warnings,
        });
      }),
    );

  flag
    .command('init')
    .description('Set up flags in a project: finds its framework, writes bridge-flags.config.json (the app and server it was wired against) and says what to install and read')
    .option('--framework <name>', 'svelte | react | nextjs | angular | nestjs | express (default: found from package.json)')
    .option('--cwd <path>', 'The project directory (default: here)')
    .option('--no-config', 'Do not write bridge-flags.config.json')
    .option('--base-url <url>', 'The server address to write (default: the one this CLI reached)')
    .option('--force', 'Overwrite an existing bridge-flags.config.json')
    .action(
      action(deps, async (ctx, opts: { framework?: string; cwd?: string; config?: boolean; baseUrl?: string; force?: boolean }) => {
        const dir = resolve(opts.cwd ?? '.');
        const FRAMEWORKS = ['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express'];
        let framework = opts.framework;
        if (framework !== undefined && !FRAMEWORKS.includes(framework)) throw new CliError('invalid', `${framework} is not a framework: ${FRAMEWORKS.join(', ')}.`);
        if (framework === undefined) {
          try {
            const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
            const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
            framework = FRAMEWORKS.find((each) => names.some((name) => name.endsWith(`bridge-${each}`))) ?? FRAMEWORKS.find((each) => names.includes(each === 'nextjs' ? 'next' : each === 'angular' ? '@angular/core' : each === 'nestjs' ? '@nestjs/core' : each));
          } catch {
            framework = undefined;
          }
          if (framework === undefined) throw new CliError('invalid', 'Could not tell which framework the project uses.', { hint: `Pass --framework <${FRAMEWORKS.join('|')}>, or --cwd <the project>.` });
        }
        const { c, appId } = await ctx.forApp();
        const app = await apps.get(c, appId);
        const baseUrl = opts.baseUrl ?? new URL(await ctx.issuer()).origin;
        const provider = framework === 'express' ? { runtime: 'none', note: 'bridge-express evaluates flags remotely inside the auth middleware; there is no local flags provider to configure.' } : framework === 'nestjs' ? { mode: 'backend', telemetry: { enabled: true, flushIntervalMs: 5000 } } : { mode: 'frontend', telemetry: { enabled: true, flushIntervalMs: 5000 } };
        const config = { appId: app.id, appName: app.name, baseUrl, framework, provider };
        let written: string | null = null;
        if (opts.config !== false) {
          const path = join(dir, 'bridge-flags.config.json');
          const exists = await access(path).then(() => true, () => false);
          if (exists && opts.force !== true) throw new CliError('conflict', `${path} exists already.`, { hint: 'Keep it, or pass --force to overwrite it.' });
          await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
          written = path;
        }
        ctx.io.result({
          framework,
          app: { id: app.id, name: app.name },
          baseUrl,
          configFile: written,
          install: { package: `@nebulr-group/bridge-${framework}`, command: `npm install @nebulr-group/bridge-${framework}` },
          nextSteps: [`Read the guide: \`bridge guide ${framework} feature-flags\`.`, 'Create the first flag: `bridge flag create <key>`.', 'Check the project against the app: `bridge doctor`.'],
        });
      }),
    );

  const schedule = flag.command('schedule').description('A state change at a time: the flag keeps its state until then');
  schedule
    .command('set <key>')
    .description('Schedule a state change, replacing the pending one')
    .requiredOption('--at <iso>', 'When, as an ISO-8601 time such as 2026-09-01T09:00:00Z')
    .requiredOption('--state <state>', `The state it moves to: ${FLAG_STATES.join(' | ')}`, oneOf(FLAG_STATES, '--state'))
    .action(
      action(deps, async (ctx, key: string, opts: { at: string; state: FlagState }) => {
        const at = new Date(opts.at);
        if (Number.isNaN(at.getTime())) throw new CliError('invalid', `--at is not an ISO-8601 time: ${opts.at}`, { hint: 'For example 2026-09-01T09:00:00Z.' });
        const { c, appId } = await ctx.forApp();
        for (const pending of await flags.schedules(c, appId, key)) await flags.unschedule(c, appId, pending.id);
        ctx.io.result(await flags.schedule(c, appId, key, at.toISOString(), opts.state));
      }),
    );
  schedule
    .command('clear <key>')
    .description('Cancel the pending state change; the flag stays as it is now')
    .action(
      action(deps, async (ctx, key: string) => {
        const { c, appId } = await ctx.forApp();
        await flags.get(c, appId, key);
        const cleared = await flags.schedules(c, appId, key);
        for (const pending of cleared) await flags.unschedule(c, appId, pending.id);
        ctx.io.result({ key, cleared: cleared.length });
      }),
    );
  schedule
    .command('list [key]')
    .description('The pending state changes, of one flag or of all')
    .action(
      action(deps, async (ctx, key: string | undefined) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await flags.schedules(c, appId, key));
      }),
    );

  flag
    .command('export')
    .description('Every flag as a portable "flags as code" bundle, to commit or to promote to another app')
    .option('--out <file>', 'Write it to a file instead of the output')
    .action(
      action(deps, async (ctx, opts: { out?: string }) => {
        const { c, appId } = await ctx.forApp();
        const bundle = await flags.export(c, appId);
        if (opts.out === undefined) return ctx.io.result(bundle);
        await writeFile(opts.out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
        ctx.io.result({ written: opts.out, flags: bundle.flags.length });
      }),
    );

  flag
    .command('import <file>')
    .description('Apply a bundle from `flag export`: creates the flags that are not there and updates the ones that are, matched by key. The whole bundle is checked before anything is written')
    .option('--dry-run', 'Say what would change, and write nothing')
    .option('--prune', 'Also delete the flags the bundle does not list (needs --yes)')
    .option('--yes', 'Confirm --prune')
    .action(
      action(deps, async (ctx, file: string, opts: { dryRun?: boolean; prune?: boolean; yes?: boolean }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
          throw new CliError('invalid', `Could not read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const list = Array.isArray(parsed) ? parsed : (parsed as { flags?: unknown } | null)?.flags;
        if (!Array.isArray(list)) throw new CliError('invalid', `${file} is not a bundle from \`bridge flag export\`: it has no "flags" list.`);
        if (opts.prune && opts.dryRun !== true && opts.yes !== true) throw new CliError('invalid', '--prune deletes flags: confirm it with --yes, or look first with --dry-run.');
        const { c, appId } = await ctx.forApp();
        const report = await flags.import(c, appId, { flags: list, ...(opts.dryRun ? { dryRun: true } : {}) });
        if (opts.prune && opts.dryRun !== true) for (const key of report.extraneous) await flags.remove(c, appId, key);
        const pruned = opts.prune ? (opts.dryRun ? { wouldDelete: report.extraneous } : { deleted: report.extraneous }) : {};
        if (!opts.prune && report.extraneous.length > 0) ctx.io.info(`${String(report.extraneous.length)} flag(s) exist in the app but not in the bundle: ${report.extraneous.join(', ')}. Nothing was deleted; --prune deletes them.`);
        ctx.io.result({ ...(opts.dryRun ? { dryRun: true } : {}), ...report, ...pruned });
      }),
    );

  const rule = flag.command('rule').description('A flag\'s rule: ordered branches of AND-ed conditions, the first match wins');

  rule.command('show <key>').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      const found = await flags.get(c, appId, key);
      ctx.io.result({ key: found.key, state: found.state, rule: found.rule });
    }),
  );

  rule
    .command('set <key>')
    .description('Replace the rule, from --rule or --rule-file')
    .option('--rule <json>', 'The rule as JSON')
    .option('--rule-file <file>', 'The rule from a JSON file')
    .action(
      action(deps, async (ctx, key: string, opts: { rule?: string; ruleFile?: string }) => {
        const given = await ruleFrom(opts);
        if (given === undefined) throw new CliError('invalid', 'Give the rule with --rule or --rule-file.');
        const { c, appId } = await ctx.forApp();
        const changed = await flags.update(c, appId, key, (current) => ({ rule: given, state: stateWithRule(current) }));
        noteIfOff(ctx, changed);
        ctx.io.result(changed);
      }),
    );

  rule
    .command('add <key>')
    .description('Add a branch to the rule: people matching every --when condition get --value (default: the on value)')
    .requiredOption('--when <condition>', '"<attribute> <operator> <value>", such as "bridge:billing.entitlement.analytics eq true"; repeat to AND them', collect)
    .option('--value <value>', 'What the branch gives')
    .option('--rollout <percent>', 'Only this share of the people it matches', percent)
    .option('--first', 'Put the branch first instead of last')
    .action(
      action(deps, async (ctx, key: string, opts: { when: string[]; value?: string; rollout?: number; first?: boolean }) => {
        const conditions = opts.when.map(parseCondition);
        const { c, appId } = await ctx.forApp();
        const changed = await flags.update(c, appId, key, (current) => {
          const branch = {
            conditions,
            returnValue: opts.value === undefined ? current.onValue : parseValue(opts.value, current.valueType),
            ...(opts.rollout === undefined ? {} : { rolloutPct: opts.rollout }),
          };
          const existing = current.rule ?? { branches: [], otherwiseValue: current.offValue };
          const branches = opts.first ? [branch, ...existing.branches] : [...existing.branches, branch];
          return { rule: { ...existing, branches }, state: stateWithRule(current) };
        });
        noteIfOff(ctx, changed);
        ctx.io.result(changed);
      }),
    );

  rule.command('clear <key>').description('Remove the rule: while on, everyone gets the on value').action(
    action(deps, async (ctx, key: string) => {
      const { c, appId } = await ctx.forApp();
      ctx.io.result(await flags.update(c, appId, key, (current) => ({ rule: null, ...(current.state === 'on-with-rule' ? { state: 'on' as const } : {}) })));
    }),
  );
}
