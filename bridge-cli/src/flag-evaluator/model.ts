/**
 * The flag model: a flag
 * has a state, typed on and off values and at most one rule; a rule is
 * ordered branches of AND-ed conditions, first match wins, then an
 * otherwise value. Nothing here names Bridge: the facts a rule reads are
 * plain names in the evaluation context, so any app, and auth-core, can use
 * the same model.
 */

/** `off` is the kill switch: it keeps the rule. `on` gives everyone the on value. `on-with-rule` runs the rule. */
export type FlagState = "off" | "on" | "on-with-rule";
export const FLAG_STATES: readonly FlagState[] = ["off", "on", "on-with-rule"];

/** The type of every value a flag can give. */
export type ValueType = "boolean" | "string" | "number" | "json";
export const VALUE_TYPES: readonly ValueType[] = ["boolean", "string", "number", "json"];

/** The twelve operators of rules, unchanged (`regex` takes a pattern without look-around or back-references). */
export const OPERATORS = ["eq", "neq", "contains", "not_contains", "in", "not_in", "gt", "lt", "between", "regex", "exists", "not_exists"] as const;
export type Operator = (typeof OPERATORS)[number];

export type ConditionValue = string | number | boolean | null;

/** One condition: a fact, an operator and its values. */
export interface Condition {
  readonly attribute: string;
  readonly operator: Operator;
  readonly values: readonly ConditionValue[];
}

/**
 * One branch of a rule. Its conditions are AND-ed with those of the
 * segments it names. `rolloutPct` takes only that share of the people the
 * branch matches (0 to 100, three decimals): the others go on to the next
 * branch, so a rollout never hides another branch's matches.
 */
export interface Branch {
  readonly conditions: readonly Condition[];
  readonly segments?: readonly string[];
  readonly returnValue: unknown;
  readonly rolloutPct?: number;
}

/**
 * A rule: branches in order, first match wins, else the otherwise value.
 * `rolloutPct` is the default of every branch that names none (rule
 * shape). `bucketBy` names the fact rollouts bucket by; by default the
 * context's targeting key.
 */
export interface Rule {
  readonly branches: readonly Branch[];
  readonly otherwiseValue: unknown;
  readonly rolloutPct?: number;
  readonly bucketBy?: string;
}

/** A flag as the evaluator reads it. */
export interface FlagDefinition {
  readonly key: string;
  readonly state: FlagState;
  readonly valueType: ValueType;
  readonly onValue: unknown;
  readonly offValue: unknown;
  readonly rule?: Rule | null;
  /**
   * What rollouts hash with, fixed when the flag is created (its first key),
   * so renaming the key moves no one. @default the key
   */
  readonly salt?: string;
}

/** A segment: saved conditions, AND-ed, reused by any branch that names it. */
export interface SegmentDefinition {
  readonly key: string;
  readonly conditions: readonly Condition[];
}

/**
 * What an evaluation knows about whoever it is for: facts by name, flat
 * (`user.role`) or nested, and the targeting key rollouts bucket by
 * (OpenFeature's evaluation context).
 */
export type EvaluationContext = Readonly<Record<string, unknown>>;

/** OpenFeature's resolution reasons, as OFREP sends them. */
export type Reason = "STATIC" | "TARGETING_MATCH" | "DISABLED" | "ERROR";

/** OpenFeature's error codes the evaluator gives. */
export type ErrorCode = "INVALID_CONTEXT" | "PARSE_ERROR" | "GENERAL";

/** Why a served value is off, by the family of the facts that kept it off (off reasons). */
export type OffReason = "plan" | "permission" | "off" | "rule" | "rollout";

/** The family of a fact, for {@link OffReason}: the caller's own table says which names are which. */
export type FactFamily = "plan" | "permission" | "other";

/** The answer for one flag: OFREP's fields, and where in the rule it came from. */
export interface Resolution {
  readonly key: string;
  readonly value: unknown;
  /** `on`, `off`, `otherwise`, or `rule-<n>` for the branch that gave it. */
  readonly variant: string;
  readonly reason: Reason;
  readonly errorCode?: ErrorCode;
  readonly errorDetails?: string;
  /**
   * OFREP's flag metadata. An off value says why in `why` (an
   * {@link OffReason}), and when a plan keeps it off, the entitlement the
   * rule asks for in `entitlement`.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  /** The branch that gave the value, -1 when none did (`variantIndex`). */
  readonly variantIndex: number;
  /** Whether the value is the flag's "on" answer: state on, or a branch matched. */
  readonly matched: boolean;
}

/** A served value that means "the feature is off". */
export function isOffValue(value: unknown): boolean {
  return value === false || value === null || value === undefined;
}
