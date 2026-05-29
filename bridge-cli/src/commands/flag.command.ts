// TBP-192 — Flag CLI parity for FF 2.0.
//
// The CLI's `flag` subcommand exposes the 2.0 mental model:
//   - Three-state model: off | on | on-with-rule
//   - Multi-type values: boolean | string | number | json
//   - Inline rules (branches + conditions + rolloutPct)
//   - Scheduling (data-only; the runner is TBP-189 — we just set/clear the field)
//   - Local eval helper for debugging
//
// Types are now first-class via @nebulr-group/bridge-auth-core 0.2.0-wt3.0:
// `FlagResponse`, `CreateFlagInput`, `UpdateFlagInput`, `FlagSchedule`,
// `FlagState`, and `FlagValueType` all describe the FF 2.0 management surface
// directly, so the SDK-boundary `as never` / `as unknown as Record<string,
// unknown>[]` casts from the 0.1.x era are gone. The local CLI rule shape
// (`Condition`, `Branch`, `Rule` below) is intentionally kept distinct from
// the package's `Rule`/`Condition` — see the note above the local interfaces.

import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import type {
  CreateFlagInput,
  FlagResponse,
  FlagSchedule,
  FlagState,
  FlagValueType,
  UpdateFlagInput,
} from '@nebulr-group/bridge-auth-core';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { registerFlagInitCommand } from './flag-init.command.js';

// ── Local rule shape ────────────────────────────────────────────────────────
//
// The CLI accepts rule JSON with conditions of shape
//   { attribute, operator, value }
// and operator names like 'equals' | 'not_equals' | 'starts_with' | ...
//
// The published auth-core 0.2.0-wt3.0 evaluator types describe a different
// shape:
//   { attribute, operator, values: ReadonlyArray<ConditionValue> }
// with a locked operator union ('eq' | 'neq' | 'contains' | 'in' | ...).
//
// These are two genuinely-different rule wire formats — bridge-api currently
// accepts the singular-`value` shape that the CLI ships. Until the CLI input
// parser is migrated (separate ticket — see report), we keep CLI-local
// `Condition` / `Branch` / `Rule` interfaces here so the local validator and
// debug evaluator stay typed against the format the CLI actually produces.

interface Condition {
  attribute: string;
  operator: string;
  value?: unknown;
}

interface Branch {
  conditions: Condition[];
  returnValue: unknown;
}

interface Rule {
  branches: Branch[];
  otherwiseValue: unknown;
  rolloutPct: number;
  groupRef?: string;
}

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
    .description('Update a feature flag (2.0 fields)')
    .requiredOption('--id <id>', 'Flag ID')
    .option('--key <key>', 'Flag key')
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
        const { id } = opts;
        const payload = buildFlagWritePayload(opts, { partial: true }) as UpdateFlagInput;
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

function registerToggle(flag: Command): void {
  flag
    .command('toggle')
    .description('Quick toggle a flag on or off (does not affect rule)')
    .requiredOption('--id <id>', 'Flag ID')
    .requiredOption('--enabled <bool>', 'true or false', (v) => v === 'true')
    .action(async (opts) => {
      try {
        const result = await getManagementClient().flags.toggle(opts.id, opts.enabled);
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
    .description('Delete a feature flag')
    .requiredOption('--id <id>', 'Flag ID')
    .action(async (opts) => {
      try {
        await getManagementClient().flags.delete(opts.id);
        outputSuccess({ deleted: true, id: opts.id });
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
          // Bridge from auth-core's package `Rule` shape (plural `values`) to
          // the CLI-local `Rule` shape (singular `value`). See note above the
          // local interfaces.
          rule: (found.rule as unknown as Rule | undefined) ?? undefined,
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

        const id = await resolveFlagId(key);
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
        const id = await resolveFlagId(key);
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
  if (d.rule !== undefined && d.rule !== null) {
    const errs = validateRule(d.rule);
    if (errs.length > 0) {
      throw new Error(
        `flags[${index}] ("${d.key}") rule failed validation:\n${errs.map((e) => `  - ${e.message}`).join('\n')}`,
      );
    }
  }
  return {
    key: d.key,
    description: d.description as string | undefined,
    state,
    valueType,
    offValue: d.offValue,
    onValue: d.onValue,
    rule: d.rule as Rule | null | undefined,
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
  const errors = validateRule(parsed);
  if (errors.length > 0) {
    throw new Error(
      `--rule failed validation:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`,
    );
  }
  return parsed as Rule;
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

async function resolveFlagId(key: string): Promise<string> {
  const all = await getManagementClient().flags.list();
  const found = all.find((f) => f.key === key);
  if (!found) throw new Error(`Flag not found: ${key}`);
  return found.id;
}

// ── Rule validation (mirrors auth-core's validateRule) ──────────────────────

interface RuleValidationError {
  branchIndex: number;
  conditionIndex: number;
  message: string;
}

const RULE_CONDITIONS_HARD_MAX = 50;

export function validateRule(rule: unknown): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  if (!rule || typeof rule !== 'object') {
    return [{ branchIndex: -1, conditionIndex: -1, message: 'Rule must be an object.' }];
  }

  const r = rule as Partial<Rule>;
  const branches = r.branches ?? [];

  if (!Array.isArray(branches)) {
    return [{ branchIndex: -1, conditionIndex: -1, message: '`branches` must be an array.' }];
  }

  let totalConditions = 0;
  branches.forEach((branch, bi) => {
    if (!branch || typeof branch !== 'object') {
      errors.push({
        branchIndex: bi,
        conditionIndex: -1,
        message: `Branch ${bi} must be an object.`,
      });
      return;
    }
    if (!('returnValue' in branch)) {
      errors.push({
        branchIndex: bi,
        conditionIndex: -1,
        message: `Branch ${bi} is missing returnValue.`,
      });
    }
    const conds = (branch as Branch).conditions ?? [];
    if (!Array.isArray(conds) || conds.length === 0) {
      errors.push({
        branchIndex: bi,
        conditionIndex: -1,
        message: `Branch ${bi} has no conditions.`,
      });
      return;
    }
    conds.forEach((c, ci) => {
      totalConditions++;
      if (!c || typeof c !== 'object') {
        errors.push({
          branchIndex: bi,
          conditionIndex: ci,
          message: `Branch ${bi} condition ${ci} must be an object.`,
        });
        return;
      }
      if (typeof c.attribute !== 'string' || c.attribute.length === 0) {
        errors.push({
          branchIndex: bi,
          conditionIndex: ci,
          message: `Branch ${bi} condition ${ci} missing 'attribute'.`,
        });
      }
      if (typeof c.operator !== 'string' || c.operator.length === 0) {
        errors.push({
          branchIndex: bi,
          conditionIndex: ci,
          message: `Branch ${bi} condition ${ci} missing 'operator'.`,
        });
      }
    });
  });

  if (totalConditions > RULE_CONDITIONS_HARD_MAX) {
    errors.push({
      branchIndex: -1,
      conditionIndex: -1,
      message: `Rule has ${totalConditions} conditions; max is ${RULE_CONDITIONS_HARD_MAX}.`,
    });
  }

  if (r.rolloutPct !== undefined) {
    if (typeof r.rolloutPct !== 'number' || r.rolloutPct < 0 || r.rolloutPct > 100) {
      errors.push({
        branchIndex: -1,
        conditionIndex: -1,
        message: `rolloutPct must be a number in [0, 100], got ${r.rolloutPct}.`,
      });
    }
  }

  if (!('otherwiseValue' in r)) {
    errors.push({
      branchIndex: -1,
      conditionIndex: -1,
      message: 'Rule missing otherwiseValue.',
    });
  }

  if (r.groupRef && branches.length > 0) {
    errors.push({
      branchIndex: -1,
      conditionIndex: -1,
      message: 'Rule cannot have both inline branches and a groupRef.',
    });
  }

  return errors;
}

// ── Local evaluator (mirrors auth-core's evaluator semantics) ───────────────

interface EvalContext {
  identity?: string;
  attributes: Record<string, unknown>;
}

interface EvalResult {
  value: unknown;
  variantIndex: number;
  matched: boolean;
  excludedByRollout: boolean;
}

interface CachedFlag {
  key: string;
  state: FlagState;
  valueType: FlagValueType;
  offValue: unknown;
  onValue: unknown;
  rule?: Rule;
}

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

function evaluateRule(rule: Rule, flagKey: string, ctx: EvalContext): EvalResult {
  const rolloutPct = clampPct(rule.rolloutPct ?? 100);

  if (rolloutPct < 100) {
    if (!ctx.identity) {
      return {
        value: rule.otherwiseValue,
        variantIndex: -1,
        matched: false,
        excludedByRollout: true,
      };
    }
    if (bucket(flagKey, ctx.identity) >= rolloutPct) {
      return {
        value: rule.otherwiseValue,
        variantIndex: -1,
        matched: false,
        excludedByRollout: true,
      };
    }
  }

  const branches = rule.branches ?? [];
  for (let i = 0; i < branches.length; i++) {
    if (evaluateBranch(branches[i], ctx)) {
      return {
        value: branches[i].returnValue,
        variantIndex: i,
        matched: true,
        excludedByRollout: false,
      };
    }
  }
  return {
    value: rule.otherwiseValue,
    variantIndex: -1,
    matched: false,
    excludedByRollout: false,
  };
}

function evaluateBranch(branch: Branch, ctx: EvalContext): boolean {
  if (!branch.conditions || branch.conditions.length === 0) return false;
  return branch.conditions.every((c) => evaluateCondition(c, resolveAttribute(ctx, c.attribute)));
}

function resolveAttribute(ctx: EvalContext, attribute: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx.attributes, attribute)) {
    return ctx.attributes[attribute];
  }
  const parts = attribute.split('.');
  let current: unknown = ctx.attributes;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateCondition(c: Condition, actual: unknown): boolean {
  const expected = c.value;
  switch (c.operator) {
    case 'equals':
    case 'eq':
      return actual === expected;
    case 'not_equals':
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    case 'not_in':
      return Array.isArray(expected) && !(expected as unknown[]).includes(actual);
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'starts_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'ends_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
      );
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    default:
      // Unknown operator → no match (defensive; validateRule should catch).
      return false;
  }
}

function bucket(flagKey: string, identity: string): number {
  const input = `${flagKey}|${identity}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash % 100;
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 100;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
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
