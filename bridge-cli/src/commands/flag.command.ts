// TBP-192 / TBP-236 — Flag CLI parity for FF 2.0.
//
// The CLI's `flag` subcommand exposes the 2.0 mental model:
//   - Three-state model: off | on | on-with-rule
//   - Multi-type values: boolean | string | number | json
//   - Inline rules (branches + conditions + rolloutPct)
//   - Scheduling (data-only; the runner is TBP-189 — we just set/clear the field)
//   - Local eval helper for debugging
//
// TBP-236: the CLI's rule format is now the canonical auth-core one. The
// `Rule` / `Branch` / `Condition` types and the `evaluateRule` / `validateRule`
// evaluator are imported from @nebulr-group/bridge-auth-core — there is no
// CLI-local rule shape anymore. Conditions always carry a plural `values`
// array on the wire, and operators come from the package's locked vocabulary
// (`OPERATORS`: eq | neq | contains | not_contains | in | not_in | gt | lt |
// between | regex | exists | not_exists). Legacy CLI inputs (singular
// `value`, operator names like `equals` / `starts_with` / `gte`) are migrated
// at parse time by `normalizeRuleInput()` below, with a deprecation warning
// on stderr for legacy operator names.

import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  OPERATORS,
  evaluateRule,
  isOperator,
  validateRule,
} from '@nebulr-group/bridge-auth-core';
import type {
  CachedFlag,
  Condition,
  ConditionValue,
  CreateFlagInput,
  EvalContext,
  EvalResult,
  FlagResponse,
  FlagSchedule,
  FlagState,
  FlagValueType,
  Operator,
  Rule,
  UpdateFlagInput,
} from '@nebulr-group/bridge-auth-core';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolveFlag, resolveFlagId } from '../resolve.js';
import { registerFlagInitCommand } from './flag-init.command.js';

// Re-export the canonical validator so existing consumers/tests keep a single
// import site for rule validation alongside the CLI parse helpers.
export { validateRule };

const FLAG_STATES: ReadonlyArray<FlagState> = ['off', 'on', 'on-with-rule'];
const FLAG_VALUE_TYPES: ReadonlyArray<FlagValueType> = ['boolean', 'string', 'number', 'json'];

// ── Public registration ─────────────────────────────────────────────────────

export function registerFlagCommands(program: Command): void {
  const flag = program
    .command('flag')
    .description(
      [
        'Manage feature flags (Feature Flags 2.0 mental model)',
        '',
        '  state   off | on | on-with-rule',
        '  values  boolean | string | number | json (typed at flag level)',
        '  rule    branches[] + otherwiseValue + rolloutPct (first-match-wins)',
      ].join('\n'),
    );

  registerList(flag);
  registerGet(flag);
  registerCreate(flag);
  registerUpdate(flag);
  registerToggle(flag);
  registerDelete(flag);
  registerEval(flag);
  registerSchedule(flag);
  registerExport(flag);
  registerImport(flag);
  registerFlagInitCommand(flag);
}

// ── list ────────────────────────────────────────────────────────────────────

function registerList(flag: Command): void {
  flag
    .command('list')
    .description('List feature flags (shows state + value type)')
    .action(async () => {
      try {
        const flags = await getManagementClient().flags.list();
        // Normalize so callers always see the same shape even if the API
        // returns the legacy fields only.
        const rows = flags.map((f) => ({
          id: f.id,
          key: f.key,
          description: f.description,
          state: f.state ?? deriveState(f),
          valueType: f.valueType ?? 'boolean',
          enabled: f.enabled,
        }));
        outputSuccess(rows);
      } catch (err) {
        outputError(err);
      }
    });
}

// ── get ─────────────────────────────────────────────────────────────────────

function registerGet(flag: Command): void {
  flag
    .command('get')
    .argument('<key>', 'Flag key')
    .description('Get a flag (rich 2.0 shape: state, value type, rule, observability)')
    .action(async (key: string) => {
      try {
        const all = await getManagementClient().flags.list();
        const found = all.find((f) => f.key === key);
        if (!found) {
          outputError(new Error(`Flag not found: ${key}`));
          return;
        }
        outputSuccess({
          id: found.id,
          key: found.key,
          description: found.description,
          state: found.state ?? deriveState(found),
          valueType: found.valueType ?? 'boolean',
          offValue: found.offValue,
          onValue: found.onValue,
          rule: found.rule,
          schedule: found.schedule,
          observability: {
            evalCount: found.evalCount,
            lastEvalAt: found.lastEvalAt,
          },
          // Echo the legacy fields too — useful while 1.0 admin clients exist.
          legacy: {
            enabled: found.enabled,
            defaultValue: found.defaultValue,
            targetValue: found.targetValue,
          },
        });
      } catch (err) {
        outputError(err);
      }
    });
}

// ── create ──────────────────────────────────────────────────────────────────

function registerCreate(flag: Command): void {
  flag
    .command('create')
    .description('Create a new feature flag (2.0 fields)')
    .requiredOption('--key <key>', 'Flag key')
    .option('--description <desc>', 'Description')
    .option(
      '--state <state>',
      `Three-state model: ${FLAG_STATES.join(' | ')} (default: off)`,
    )
    .option(
      '--value-type <type>',
      `Flag value type: ${FLAG_VALUE_TYPES.join(' | ')} (default: boolean)`,
    )
    .option(
      '--on-value <value>',
      'Value returned when state=on (parsed per --value-type; JSON string for json type)',
    )
    .option(
      '--off-value <value>',
      'Value returned when state=off (parsed per --value-type)',
    )
    .option(
      '--rule <json>',
      'Rule as a JSON string: {"branches":[...],"otherwiseValue":...,"rolloutPct":100}',
    )
    // Legacy 1.0 fields kept so existing scripts don't break.
    .option('--enabled', 'Legacy: enable the flag', false)
    .option('--default-value', 'Legacy: default value when no segment matches', false)
    .action(async (opts) => {
      try {
        // `--key` is a requiredOption above, so `key` is always present at
        // runtime even though buildFlagWritePayload's generic return type
        // can't express that. The `unknown` step is just to convince TS the
        // intent is deliberate.
        const payload = buildFlagWritePayload(opts) as unknown as CreateFlagInput;
        const flag = await getManagementClient().flags.create(payload);
        outputSuccess(flag);
      } catch (err) {
        outputError(err);
      }
    });
}

// ── update ──────────────────────────────────────────────────────────────────

function registerUpdate(flag: Command): void {
  flag
    .command('update')
    .description('Update a feature flag by --key or --id (2.0 fields)')
    .option('--key <key>', 'Flag key to address (alternative to --id)')
    .option('--id <id>', 'Flag ID to address (alternative to --key)')
    .option('--new-key <key>', 'Rename the flag to this key')
    .option('--description <desc>', 'Description')
    .option('--state <state>', `Three-state model: ${FLAG_STATES.join(' | ')}`)
    .option('--value-type <type>', `Flag value type: ${FLAG_VALUE_TYPES.join(' | ')}`)
    .option('--on-value <value>', 'Value returned when state=on (parsed per --value-type)')
    .option('--off-value <value>', 'Value returned when state=off (parsed per --value-type)')
    .option('--rule <json>', 'Rule as a JSON string (must validate via validateRule)')
    .option('--clear-rule', 'Remove the existing rule')
    // Legacy 1.0
    .option('--enabled <bool>', 'Legacy: enable/disable', (v) => v === 'true')
    .option('--default-value <bool>', 'Legacy: default value', (v) => v === 'true')
    .action(async (opts) => {
      try {
        // TBP-586. `--key` is overloaded here for backwards compatibility:
        // before key-addressing existed, `flag update --id X --key Y` renamed
        // the flag to Y, and that still works. So `--key` means "address this
        // flag" only when `--id` is absent; alongside `--id` it keeps its old
        // rename meaning. `--new-key` renames in either addressing mode.
        const addressedById = opts.id !== undefined;
        const renameTo = opts.newKey !== undefined
          ? opts.newKey
          : (addressedById ? opts.key : undefined);
        const id = await resolveFlagId({
          id: opts.id,
          key: addressedById ? undefined : opts.key,
        });
        const payload = buildFlagWritePayload(
          { ...opts, key: renameTo },
          { partial: true },
        ) as UpdateFlagInput;
        if (opts.clearRule) {
          payload.rule = null;
        }
        const flag = await getManagementClient().flags.update(id, payload);
        outputSuccess(flag);
      } catch (err) {
        outputError(err);
      }
    });
}

// ── toggle (kept from 1.0; convenience for state on/off without typing JSON) ─
//
// TBP-548. The command used to call `flags.toggle()`, which PUT the FF 1.0
// `{ enabled }` boolean. FF 2.0 dropped that field from the flag document and
// evaluates on `state` alone, and the server's write DTO strips undeclared
// keys — so the body arrived empty, the API answered 200 with the untouched
// flag, and the CLI printed `success: true` for a flag that had not moved.
//
// The mapping below is the one the MCP `toggle_feature_flag` tool settled on
// (TBP-587), so the two surfaces over the same endpoint agree:
//
//   --enabled true   → state "on"    (everyone gets onValue)
//   --enabled false  → state "off"   (everyone gets offValue)
//
// with one refusal: a flag already at "on-with-rule" is not turned ON here.
// "on" stops the rule being consulted and hands onValue to every caller, which
// widens the audience instead of flipping a switch — `flag update --state on`
// is where you say that deliberately. Turning such a flag OFF stays allowed:
// the rule document is preserved, so it is reversible.

/** Error carrying a machine-readable `code` for `outputError` to report. */
class FlagCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FlagCommandError';
    this.code = code;
  }
}

function registerToggle(flag: Command): void {
  flag
    .command('toggle')
    .description(
      'Quick toggle a flag on or off by --key or --id — sets state=on / state=off (the rule is kept)',
    )
    .option('--key <key>', 'Flag key to address (alternative to --id)')
    .option('--id <id>', 'Flag ID to address (alternative to --key)')
    .requiredOption('--enabled <bool>', 'true = state on, false = state off', (v) => v === 'true')
    .action(async (opts) => {
      try {
        const enabled: boolean = opts.enabled;
        const current = await resolveFlag({ id: opts.id, key: opts.key });
        const currentState = current.state ?? deriveState(current);

        if (currentState === 'on-with-rule' && enabled) {
          throw new FlagCommandError(
            'FLAG_HAS_TARGETING',
            `Flag '${current.key}' is state=on-with-rule: a targeting rule decides who gets it. ` +
              'Turning it fully on would give it to everyone and stop the rule being consulted, ' +
              'so nothing was changed. It is already on for whoever the rule matches. To widen it ' +
              'to everyone deliberately, run `bridge flag update --key ' +
              `${current.key} --state on\` (the rule is preserved and you can set it back to ` +
              'on-with-rule later).',
          );
        }

        const wanted: FlagState = enabled ? 'on' : 'off';
        const result = await getManagementClient().flags.update(current.id, { state: wanted });

        // Read the write back rather than trusting the 200. The original bug
        // was invisible precisely because nobody checked that it landed.
        const resultingState = result?.state ?? (result ? deriveState(result) : undefined);
        if (resultingState !== wanted) {
          throw new FlagCommandError(
            'TOGGLE_NOT_APPLIED',
            `Requested state='${wanted}' for '${current.key}' but the flag came back as ` +
              `state='${resultingState ?? 'unknown'}'. The change did NOT take effect. ` +
              'Re-read it with `bridge flag get ' +
              `${current.key}\`, then set the state explicitly with \`bridge flag update\`.`,
          );
        }

        outputSuccess(result);
      } catch (err) {
        outputError(err);
      }
    });
}

// ── delete ──────────────────────────────────────────────────────────────────

function registerDelete(flag: Command): void {
  flag
    .command('delete')
    .description('Delete a feature flag by --key or --id')
    .option('--key <key>', 'Flag key to address (alternative to --id)')
    .option('--id <id>', 'Flag ID to address (alternative to --key)')
    .action(async (opts) => {
      try {
        const id = await resolveFlagId({ id: opts.id, key: opts.key });
        await getManagementClient().flags.delete(id);
        outputSuccess({ deleted: true, id });
      } catch (err) {
        outputError(err);
      }
    });
}

// ── eval (local SDK-style evaluation, for debugging) ────────────────────────

function registerEval(flag: Command): void {
  flag
    .command('eval')
    .argument('<key>', 'Flag key')
    .description('Locally evaluate a flag against a synthetic context (debug helper)')
    .option('--identity <id>', 'Eval identity (required when rolloutPct < 100)')
    .option(
      '--attribute <kv...>',
      'One or more key=value attributes (use multiple flags or space-separate)',
    )
    .action(async (key: string, opts) => {
      try {
        const all = await getManagementClient().flags.list();
        const found = all.find((f) => f.key === key);
        if (!found) {
          outputError(new Error(`Flag not found: ${key}`));
          return;
        }

        const attributes = parseAttributes(opts.attribute ?? []);
        const ctx = { identity: opts.identity as string | undefined, attributes };

        const cached: CachedFlag = {
          key: found.key,
          state: found.state ?? deriveState(found),
          valueType: found.valueType ?? 'boolean',
          offValue: found.offValue ?? false,
          onValue: found.onValue ?? true,
          // `FlagResponse.rule` is the canonical auth-core `Rule` — no
          // bridging cast needed (TBP-236).
          rule: found.rule ?? undefined,
        };

        const result = evaluateLocally(cached, ctx);
        outputSuccess({
          flag: cached.key,
          state: cached.state,
          context: ctx,
          result,
        });
      } catch (err) {
        outputError(err);
      }
    });
}

// ── schedule ────────────────────────────────────────────────────────────────

function registerSchedule(flag: Command): void {
  const schedule = flag
    .command('schedule')
    .description('Manage scheduled state changes (TBP-189 — runner not yet active)');

  schedule
    .command('set')
    .argument('<key>', 'Flag key')
    .description('Schedule a state transition at an ISO timestamp')
    .requiredOption('--at <iso>', 'ISO-8601 timestamp (e.g. 2026-05-20T09:00:00Z)')
    .requiredOption('--state <state>', `Target state: ${FLAG_STATES.join(' | ')}`)
    .action(async (key: string, opts) => {
      try {
        if (!FLAG_STATES.includes(opts.state)) {
          throw new Error(
            `Invalid --state: ${opts.state}. Must be one of ${FLAG_STATES.join(', ')}.`,
          );
        }
        const at = new Date(opts.at);
        if (Number.isNaN(at.getTime())) {
          throw new Error(`Invalid --at: ${opts.at} is not a valid ISO-8601 timestamp.`);
        }

        const id = await resolveFlagId({ key });
        const schedule: FlagSchedule = { at: at.toISOString(), state: opts.state as FlagState };
        const update: UpdateFlagInput = { schedule };
        const result = await getManagementClient().flags.update(id, update);
        outputSuccess(result);
      } catch (err) {
        outputError(err);
      }
    });

  schedule
    .command('clear')
    .argument('<key>', 'Flag key')
    .description('Clear an existing schedule')
    .action(async (key: string) => {
      try {
        const id = await resolveFlagId({ key });
        const update: UpdateFlagInput = { schedule: null };
        const result = await getManagementClient().flags.update(id, update);
        outputSuccess(result);
      } catch (err) {
        outputError(err);
      }
    });
}

// ── flags-as-code: export / import ──────────────────────────────────────────
// Serialize the full 2.0 flag config to a file (version-control, env promotion)
// and apply it back with a create / update / prune diff. Reuses validateRule +
// deriveState + the FLAG_* constants so the on-disk format matches `flag get`.

interface FlagDoc {
  key: string;
  description?: string;
  state: FlagState;
  valueType: FlagValueType;
  offValue?: unknown;
  onValue?: unknown;
  rule?: Rule | null;
  schedule?: unknown;
}

/** Build the canonical, portable doc from a remote flag record. Pure. */
export function toFlagDoc(f: Record<string, unknown>): FlagDoc {
  return {
    key: f.key as string,
    description: f.description as string | undefined,
    state: (f.state as FlagState | undefined) ?? deriveState(f as unknown as FlagResponse),
    valueType: (f.valueType as FlagValueType | undefined) ?? 'boolean',
    offValue: f.offValue,
    onValue: f.onValue,
    rule: f.rule as Rule | null | undefined,
    schedule: f.schedule,
  };
}

/** Build a create/update write payload from a doc. Pure. */
export function buildWritePayloadFromDoc(doc: FlagDoc): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    key: doc.key,
    state: doc.state,
    valueType: doc.valueType,
  };
  if (doc.description !== undefined) payload.description = doc.description;
  if (doc.offValue !== undefined) payload.offValue = doc.offValue;
  if (doc.onValue !== undefined) payload.onValue = doc.onValue;
  if (doc.rule !== undefined) payload.rule = doc.rule;
  if (doc.schedule !== undefined) payload.schedule = doc.schedule;
  return payload;
}

/** Validate + normalize a doc parsed from a file. Throws on the first problem. */
export function validateFlagDoc(input: unknown, index: number): FlagDoc {
  if (!input || typeof input !== 'object') {
    throw new Error(`flags[${index}] must be an object.`);
  }
  const d = input as Record<string, unknown>;
  if (typeof d.key !== 'string' || d.key.length === 0) {
    throw new Error(`flags[${index}] is missing a non-empty "key".`);
  }
  const state = (d.state as FlagState | undefined) ?? 'off';
  if (!FLAG_STATES.includes(state)) {
    throw new Error(
      `flags[${index}] ("${d.key}") invalid state "${String(d.state)}". One of ${FLAG_STATES.join(', ')}.`,
    );
  }
  const valueType = (d.valueType as FlagValueType | undefined) ?? 'boolean';
  if (!FLAG_VALUE_TYPES.includes(valueType)) {
    throw new Error(
      `flags[${index}] ("${d.key}") invalid valueType "${String(d.valueType)}". One of ${FLAG_VALUE_TYPES.join(', ')}.`,
    );
  }
  let rule: Rule | null | undefined = d.rule as Rule | null | undefined;
  if (d.rule !== undefined && d.rule !== null) {
    let normalized: Rule;
    try {
      normalized = normalizeRuleInput(d.rule);
    } catch (err) {
      throw new Error(
        `flags[${index}] ("${d.key}") rule failed validation:\n  - ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const errs = validateRule(normalized);
    if (errs.length > 0) {
      throw new Error(
        `flags[${index}] ("${d.key}") rule failed validation:\n${errs.map((e) => `  - ${e.message}`).join('\n')}`,
      );
    }
    rule = normalized;
  }
  return {
    key: d.key,
    description: d.description as string | undefined,
    state,
    valueType,
    offValue: d.offValue,
    onValue: d.onValue,
    rule,
    schedule: d.schedule,
  };
}

interface FlagDiff {
  create: FlagDoc[];
  update: { id: string; doc: FlagDoc; changes: string[] }[];
  prune: { id: string; key: string }[];
  unchanged: string[];
}

const DOC_FIELDS: ReadonlyArray<keyof FlagDoc> = [
  'description',
  'state',
  'valueType',
  'offValue',
  'onValue',
  'rule',
  'schedule',
];

function docChanges(a: FlagDoc, b: FlagDoc): string[] {
  return DOC_FIELDS.filter(
    (f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null),
  );
}

/** Diff file docs against remote flags (matched by key). Pure. */
export function diffFlags(
  remote: Record<string, unknown>[],
  docs: FlagDoc[],
  opts: { prune?: boolean } = {},
): FlagDiff {
  const byKey = new Map(remote.map((f) => [f.key as string, f]));
  const fileKeys = new Set(docs.map((d) => d.key));
  const diff: FlagDiff = { create: [], update: [], prune: [], unchanged: [] };

  for (const doc of docs) {
    const r = byKey.get(doc.key);
    if (!r) {
      diff.create.push(doc);
      continue;
    }
    const changes = docChanges(toFlagDoc(r), doc);
    if (changes.length === 0) diff.unchanged.push(doc.key);
    else diff.update.push({ id: r.id as string, doc, changes });
  }

  if (opts.prune) {
    for (const r of remote) {
      if (!fileKeys.has(r.key as string)) {
        diff.prune.push({ id: r.id as string, key: r.key as string });
      }
    }
  }

  return diff;
}

function registerExport(flag: Command): void {
  flag
    .command('export')
    .description('Export all feature flags as code (canonical 2.0 JSON)')
    .option('--out <file>', 'Write to a file instead of stdout')
    .action(async (opts) => {
      try {
        const all = (await getManagementClient().flags.list()) as unknown as Record<
          string,
          unknown
        >[];
        const flags = all.map(toFlagDoc).sort((a, b) => a.key.localeCompare(b.key));
        const bundle = { version: 1, flags };
        if (opts.out) {
          writeFileSync(opts.out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
          outputSuccess({ written: opts.out, count: flags.length });
        } else {
          outputSuccess(bundle);
        }
      } catch (err) {
        outputError(err);
      }
    });
}

function registerImport(flag: Command): void {
  flag
    .command('import')
    .argument('<file>', 'Path to a flags JSON file (from `flag export`)')
    .description('Apply feature flags from a file (create + update; --prune deletes extras)')
    .option('--dry-run', 'Show the diff without applying any changes', false)
    .option('--prune', 'Delete remote flags not present in the file', false)
    .action(async (file: string, opts) => {
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
          throw new Error(
            `Could not read/parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const list = Array.isArray(raw) ? raw : (raw as { flags?: unknown }).flags;
        if (!Array.isArray(list)) {
          throw new Error('File must be an array of flags or an object with a "flags" array.');
        }
        const docs = list.map((d, i) => validateFlagDoc(d, i));

        const remote = (await getManagementClient().flags.list()) as unknown as Record<
          string,
          unknown
        >[];
        const diff = diffFlags(remote, docs, { prune: opts.prune });

        if (opts.dryRun) {
          outputSuccess({
            dryRun: true,
            create: diff.create.map((d) => d.key),
            update: diff.update.map((u) => ({ key: u.doc.key, changes: u.changes })),
            prune: diff.prune.map((p) => p.key),
            unchanged: diff.unchanged,
          });
          return;
        }

        const mgmt = getManagementClient();
        for (const doc of diff.create) {
          await mgmt.flags.create(buildWritePayloadFromDoc(doc) as never);
        }
        for (const u of diff.update) {
          await mgmt.flags.update(u.id, buildWritePayloadFromDoc(u.doc) as never);
        }
        for (const p of diff.prune) {
          await mgmt.flags.delete(p.id);
        }

        outputSuccess({
          created: diff.create.map((d) => d.key),
          updated: diff.update.map((u) => u.doc.key),
          pruned: diff.prune.map((p) => p.key),
          unchanged: diff.unchanged,
        });
      } catch (err) {
        outputError(err);
      }
    });
}

// ── Internals ───────────────────────────────────────────────────────────────

interface FlagWriteOpts {
  key?: string;
  description?: string;
  state?: string;
  valueType?: string;
  onValue?: string;
  offValue?: string;
  rule?: string;
  enabled?: boolean;
  defaultValue?: boolean;
}

export function buildFlagWritePayload(
  opts: FlagWriteOpts,
  { partial = false }: { partial?: boolean } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (opts.key !== undefined) payload.key = opts.key;
  if (opts.description !== undefined) payload.description = opts.description;

  if (opts.state !== undefined) {
    if (!FLAG_STATES.includes(opts.state as FlagState)) {
      throw new Error(
        `Invalid --state: ${opts.state}. Must be one of ${FLAG_STATES.join(', ')}.`,
      );
    }
    payload.state = opts.state;
  }

  let valueType: FlagValueType | undefined;
  if (opts.valueType !== undefined) {
    if (!FLAG_VALUE_TYPES.includes(opts.valueType as FlagValueType)) {
      throw new Error(
        `Invalid --value-type: ${opts.valueType}. Must be one of ${FLAG_VALUE_TYPES.join(', ')}.`,
      );
    }
    valueType = opts.valueType as FlagValueType;
    payload.valueType = valueType;
  }

  if (opts.onValue !== undefined) {
    payload.onValue = coerceValue(opts.onValue, valueType ?? 'boolean');
  }
  if (opts.offValue !== undefined) {
    payload.offValue = coerceValue(opts.offValue, valueType ?? 'boolean');
  }

  if (opts.rule !== undefined) {
    const parsed = parseRuleArg(opts.rule);
    payload.rule = parsed;
  }

  // Legacy fields. In partial (update) mode, only include if explicitly set —
  // commander returns `false` as default for boolean flags, which would
  // otherwise clobber server state on every update.
  if (!partial || opts.enabled !== undefined) {
    if (opts.enabled !== undefined) payload.enabled = opts.enabled;
  }
  if (!partial || opts.defaultValue !== undefined) {
    if (opts.defaultValue !== undefined) payload.defaultValue = opts.defaultValue;
  }

  return payload;
}

export function coerceValue(raw: string, type: FlagValueType): unknown {
  switch (type) {
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`Invalid boolean value "${raw}" — expected "true" or "false".`);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Invalid number value "${raw}".`);
      return n;
    }
    case 'string':
      return raw;
    case 'json':
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Invalid JSON value: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
  }
}

export function parseRuleArg(raw: string): Rule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--rule must be valid JSON. Parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let rule: Rule;
  try {
    rule = normalizeRuleInput(parsed);
  } catch (err) {
    throw new Error(
      `--rule failed validation:\n  - ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const errors = validateRule(rule);
  if (errors.length > 0) {
    throw new Error(
      `--rule failed validation:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`,
    );
  }
  return rule;
}

// ── Parse-time rule normalization (TBP-236) ─────────────────────────────────
//
// The CLI historically accepted conditions of shape { attribute, operator,
// value } with operator names like 'equals' / 'starts_with' / 'gte'. The
// canonical auth-core format is { attribute, operator, values: [...] } with
// the locked operator vocabulary in `OPERATORS`. `normalizeRuleInput` migrates
// legacy input to the canonical shape at parse time:
//   - scalar `value` → plural `values` array (`"value": "pro"` → `values: ["pro"]`)
//   - legacy operator names → canonical ones (deprecation warning on stderr)
// Structurally invalid input (non-object rule, missing otherwiseValue, ...)
// throws; unknown operators are passed through for `validateRule` to report.

/** Legacy operator names that map 1:1 onto a canonical operator. */
const LEGACY_OPERATOR_ALIASES: Readonly<Record<string, Operator>> = {
  equals: 'eq',
  equal: 'eq',
  not_equals: 'neq',
  not_equal: 'neq',
  notEquals: 'neq',
  does_not_contain: 'not_contains',
  notContains: 'not_contains',
  greater_than: 'gt',
  greaterThan: 'gt',
  less_than: 'lt',
  lessThan: 'lt',
  matches: 'regex',
};

function warnDeprecatedOperator(legacy: string, canonical: Operator, note?: string): void {
  process.stderr.write(
    `Warning: rule operator "${legacy}" is deprecated; mapped to "${canonical}"${note ? ` (${note})` : ''}. ` +
      `Canonical operators: ${OPERATORS.join(', ')}.\n`,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map a (possibly legacy) operator name + values to the canonical vocabulary.
 * Some legacy operators have no 1:1 canonical equivalent and are rewritten
 * with adjusted values:
 *   starts_with x → regex ^x        ends_with x → regex x$
 *   gte x         → between [x, Number.MAX_VALUE]
 *   lte x         → between [-Number.MAX_VALUE, x]
 * Unknown names are passed through so validateRule reports them.
 */
function resolveOperator(
  op: string,
  values: ConditionValue[],
): { operator: Operator; values: ConditionValue[] } {
  if (isOperator(op)) return { operator: op, values };

  const alias = LEGACY_OPERATOR_ALIASES[op];
  if (alias) {
    warnDeprecatedOperator(op, alias);
    return { operator: alias, values };
  }

  switch (op) {
    case 'starts_with':
    case 'startsWith':
    case 'begins_with':
    case 'beginsWith':
      warnDeprecatedOperator(op, 'regex', 'value rewritten to an anchored ^… pattern');
      return { operator: 'regex', values: [`^${escapeRegExp(String(values[0] ?? ''))}`] };
    case 'ends_with':
    case 'endsWith':
      warnDeprecatedOperator(op, 'regex', 'value rewritten to an anchored …$ pattern');
      return { operator: 'regex', values: [`${escapeRegExp(String(values[0] ?? ''))}$`] };
    case 'gte':
    case 'greater_than_or_equal':
    case 'greaterThanOrEqual':
      warnDeprecatedOperator(op, 'between', 'rewritten to between [value, Number.MAX_VALUE]');
      return { operator: 'between', values: [values[0] ?? null, Number.MAX_VALUE] };
    case 'lte':
    case 'less_than_or_equal':
    case 'lessThanOrEqual':
      warnDeprecatedOperator(op, 'between', 'rewritten to between [-Number.MAX_VALUE, value]');
      return { operator: 'between', values: [-Number.MAX_VALUE, values[0] ?? null] };
    default:
      // Unknown operator — pass through; validateRule will flag it.
      return { operator: op as Operator, values };
  }
}

function normalizeConditionInput(input: unknown, bi: number, ci: number): Condition {
  if (!input || typeof input !== 'object') {
    throw new Error(`Branch ${bi} condition ${ci} must be an object.`);
  }
  const c = input as Record<string, unknown>;
  if (typeof c.attribute !== 'string' || c.attribute.length === 0) {
    throw new Error(`Branch ${bi} condition ${ci} missing 'attribute'.`);
  }
  if (typeof c.operator !== 'string' || c.operator.length === 0) {
    throw new Error(`Branch ${bi} condition ${ci} missing 'operator'.`);
  }

  let values: ConditionValue[];
  if (c.values !== undefined) {
    if (!Array.isArray(c.values)) {
      throw new Error(`Branch ${bi} condition ${ci} 'values' must be an array.`);
    }
    values = [...(c.values as ConditionValue[])];
  } else if ('value' in c) {
    // Legacy singular `value` — migrate to plural `values` at parse time.
    const v = c.value;
    values = Array.isArray(v) ? [...(v as ConditionValue[])] : [v as ConditionValue];
  } else {
    values = [];
  }

  const resolved = resolveOperator(c.operator, values);
  return { attribute: c.attribute, operator: resolved.operator, values: resolved.values };
}

/**
 * Normalize untrusted rule input (from --rule JSON or a flags file) to the
 * canonical auth-core `Rule` shape. Throws on structural problems; operator
 * validity is left to `validateRule` on the returned rule.
 */
export function normalizeRuleInput(input: unknown): Rule {
  if (!input || typeof input !== 'object') {
    throw new Error('Rule must be an object.');
  }
  const r = input as Record<string, unknown>;

  if (!('otherwiseValue' in r)) {
    throw new Error('Rule missing otherwiseValue.');
  }

  const rawBranches = r.branches ?? [];
  if (!Array.isArray(rawBranches)) {
    throw new Error('`branches` must be an array.');
  }
  const branches = rawBranches.map((branch, bi) => {
    if (!branch || typeof branch !== 'object') {
      throw new Error(`Branch ${bi} must be an object.`);
    }
    const b = branch as Record<string, unknown>;
    if (!('returnValue' in b)) {
      throw new Error(`Branch ${bi} is missing returnValue.`);
    }
    const rawConds = b.conditions ?? [];
    if (!Array.isArray(rawConds)) {
      throw new Error(`Branch ${bi} 'conditions' must be an array.`);
    }
    return {
      conditions: rawConds.map((c, ci) => normalizeConditionInput(c, bi, ci)),
      returnValue: b.returnValue,
    };
  });

  const rule: Rule = {
    branches,
    otherwiseValue: r.otherwiseValue,
    // Canonical `Rule` carries rolloutPct explicitly; default to 100 (full
    // rollout) when the input omits it. Out-of-range values are kept so
    // validateRule reports them.
    rolloutPct: r.rolloutPct === undefined ? 100 : (r.rolloutPct as number),
  };
  if (typeof r.groupRef === 'string' && r.groupRef.length > 0) {
    rule.groupRef = r.groupRef;
  }
  return rule;
}

export function parseAttributes(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) throw new Error(`Invalid --attribute "${pair}" — expected key=value.`);
    const key = pair.slice(0, idx);
    const raw = pair.slice(idx + 1);
    // Try to parse as JSON first (covers numbers, booleans, structured); fall
    // back to the raw string.
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

// ── Local evaluator (delegates to auth-core's canonical evaluator) ──────────

export function evaluateLocally(cached: CachedFlag, ctx: EvalContext): EvalResult {
  switch (cached.state) {
    case 'off':
      return {
        value: cached.offValue,
        variantIndex: -1,
        matched: false,
        excludedByRollout: false,
      };
    case 'on':
      return {
        value: cached.onValue,
        variantIndex: 0,
        matched: true,
        excludedByRollout: false,
      };
    case 'on-with-rule':
      if (!cached.rule) {
        return {
          value: cached.onValue,
          variantIndex: -1,
          matched: false,
          excludedByRollout: false,
        };
      }
      return evaluateRule(cached.rule, cached.key, ctx);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a 2.0 state from a legacy 1.0 flag shape. Used so `flag list` /
 * `flag get` always show a state column, even against an older bridge-api
 * that has not yet rolled out 2.0 fields.
 */
function deriveState(f: FlagResponse): FlagState {
  if (typeof f.state === 'string' && FLAG_STATES.includes(f.state as FlagState)) {
    return f.state as FlagState;
  }
  if (f.enabled === false) return 'off';
  const segs = f.segments ?? [];
  return segs.length > 0 ? 'on-with-rule' : 'on';
}
