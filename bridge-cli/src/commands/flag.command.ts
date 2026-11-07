import { readFile } from 'node:fs/promises';
import { InvalidArgumentError, type Command } from 'commander';
import { FLAG_STATES, VALUE_TYPES, flags, parseCondition, parseRule, parseValue, type Flag, type FlagFields, type FlagState, type Rule, type ValueType } from '../api/flags.js';
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
    .requiredOption('--yes', 'Confirm')
    .action(
      action(deps, async (ctx, key: string) => {
        const { c, appId } = await ctx.forApp();
        ctx.io.result(await flags.remove(c, appId, key));
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
