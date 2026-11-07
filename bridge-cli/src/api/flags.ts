import type { BridgeClient } from '../client.js';
import { CliError } from '../core/errors.js';

export const FLAG_STATES = ['off', 'on', 'on-with-rule'] as const;
export type FlagState = (typeof FLAG_STATES)[number];
export const VALUE_TYPES = ['boolean', 'string', 'number', 'json'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export const OPERATORS = ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'lt', 'between', 'regex', 'exists', 'not_exists'] as const;
export type Operator = (typeof OPERATORS)[number];

export type ConditionValue = string | number | boolean | null;

export interface Condition {
  attribute: string;
  operator: Operator;
  values: ConditionValue[];
}

/** One branch of a rule: its conditions are AND-ed; the first branch that matches gives its value. */
export interface Branch {
  conditions: Condition[];
  segments?: string[];
  returnValue: unknown;
  rolloutPct?: number;
}

export interface Rule {
  branches: Branch[];
  otherwiseValue: unknown;
  rolloutPct?: number;
  bucketBy?: string;
}

export interface FlagFields {
  key?: string;
  description?: string;
  state?: FlagState;
  valueType?: ValueType;
  onValue?: unknown;
  offValue?: unknown;
  rule?: Rule | null;
  public?: boolean;
}

export interface Flag extends FlagFields {
  readonly key: string;
  readonly state: FlagState;
  readonly valueType: ValueType;
  readonly rule: Rule | null;
  readonly revision: number;
  readonly [field: string]: unknown;
}

const body = <T>(answer: { body: T }) => answer.body;

/** `If-Match` for a change made on the flag as it was read: version 2 refuses a change that names no revision. */
const revisionOf = (flag: Flag) => ({ 'if-match': `"${String(flag.revision)}"` });

export const flags = {
  list: (c: BridgeClient, appId: string) => c.person<Flag[]>('flagsList', { params: { appId } }).then(body),
  get: (c: BridgeClient, appId: string, key: string) => c.person<Flag>('flagsGet', { params: { appId, key } }).then(body),
  create: (c: BridgeClient, appId: string, fields: FlagFields & { key: string }) => c.person<Flag>('flagsCreate', { params: { appId }, body: fields }).then(body),

  /** Changes the flag as it is now: read, changed, written with its revision, so a change made meanwhile is never overwritten. */
  async update(c: BridgeClient, appId: string, key: string, change: FlagFields | ((flag: Flag) => FlagFields)): Promise<Flag> {
    const current = await flags.get(c, appId, key);
    const fields = typeof change === 'function' ? change(current) : change;
    return c.person<Flag>('flagsUpdate', { params: { appId, key }, body: fields, headers: revisionOf(current) }).then(body);
  },
  async remove(c: BridgeClient, appId: string, key: string): Promise<unknown> {
    const current = await flags.get(c, appId, key);
    return c.person('flagsDelete', { params: { appId, key }, headers: revisionOf(current) }).then(body);
  },
  /** Switches the flag off and keeps its rule, so `restore` brings back what it was. */
  kill: (c: BridgeClient, appId: string, key: string) => c.person<Flag>('flagsKill', { params: { appId, key } }).then(body),
  restore: (c: BridgeClient, appId: string, key: string) => c.person<Flag>('flagsRestore', { params: { appId, key } }).then(body),
  segments: (c: BridgeClient, appId: string) => c.person('segmentsList', { params: { appId } }).then(body),
};

/** A value written in a condition: true, false, null and numbers as themselves, anything else as text. */
function conditionValue(raw: string): ConditionValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw.replace(/^"(.*)"$/, '$1');
}

/**
 * One condition written in words: `<attribute> <operator> [value[,value…]]`.
 * `in`, `not_in` and `between` take a comma-separated list; `exists` and
 * `not_exists` take none.
 *
 *   privileges contains USER_WRITE
 *   bridge:billing.entitlement.analytics eq true
 *   user.email in a@example.com,b@example.com
 */
export function parseCondition(text: string): Condition {
  const match = /^\s*(\S+)\s+(\S+)(?:\s+(.*?))?\s*$/.exec(text);
  if (!match) throw new CliError('invalid', `A condition is "<attribute> <operator> <value>": ${text}`);
  const [, attribute, operator, rest] = match as unknown as [string, string, string, string | undefined];
  if (!(OPERATORS as readonly string[]).includes(operator)) {
    throw new CliError('invalid', `${operator} is not an operator. The operators are: ${OPERATORS.join(', ')}.`);
  }
  const op = operator as Operator;
  if (op === 'exists' || op === 'not_exists') {
    if (rest) throw new CliError('invalid', `${op} takes no value: ${text}`);
    return { attribute, operator: op, values: [] };
  }
  if (rest === undefined || rest === '') throw new CliError('invalid', `${op} needs a value: ${text}`);
  const values = op === 'in' || op === 'not_in' || op === 'between' ? rest.split(',').map((each) => conditionValue(each.trim())) : [conditionValue(rest)];
  if (op === 'between' && values.length !== 2) throw new CliError('invalid', `between takes two values, "low,high": ${text}`);
  return { attribute, operator: op, values };
}

/** A flag value written on the command line, read as the flag's type. */
export function parseValue(raw: string, type: ValueType): unknown {
  switch (type) {
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw new CliError('invalid', `A boolean flag's value is true or false, not ${raw}.`);
      return raw === 'true';
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) throw new CliError('invalid', `A number flag's value is a number, not ${raw}.`);
      return n;
    }
    case 'json':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new CliError('invalid', `A json flag's value is JSON: ${raw}`);
      }
    default:
      return raw;
  }
}

/** A rule given as JSON, checked for its shape before it is sent. */
export function parseRule(json: string): Rule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError('invalid', 'The rule is not valid JSON.');
  }
  const rule = parsed as Partial<Rule>;
  if (typeof rule !== 'object' || rule === null || !Array.isArray(rule.branches) || !('otherwiseValue' in rule)) {
    throw new CliError('invalid', 'A rule is { "branches": [{ "conditions": [...], "returnValue": … }], "otherwiseValue": … }.');
  }
  return rule as Rule;
}
