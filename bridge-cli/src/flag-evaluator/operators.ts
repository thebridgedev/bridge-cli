import { OPERATORS, type Condition, type ConditionValue, type Operator } from "./model.js";

/**
 * The hard limits of an evaluation. A rule beyond them is refused when it is saved; a
 * context beyond them is an error, never a slow answer.
 */
export const LIMITS = {
  /** Conditions in one rule, across its branches . */
  conditionsPerRule: 50,
  /** Branches in one rule. */
  branchesPerRule: 50,
  /** Values of an `in` or `not_in` condition . */
  valuesPerCondition: 1_000,
  /** Segments one branch names, and conditions one segment holds. */
  segmentsPerBranch: 10,
  conditionsPerSegment: 50,
  /** Condition checks in one evaluation, segments included: the step budget. */
  steps: 1_000,
  /** Facts in one context, the characters of one text fact or pattern input, and the items of one list fact. */
  contextFacts: 200,
  factLength: 10_000,
  listLength: 1_000,
  /** Dots in a fact's name, which is walked as a path. */
  pathDepth: 10,
  /** Characters of one regex pattern. */
  patternLength: 1_000,
} as const;

export function isOperator(value: unknown): value is Operator {
  return typeof value === "string" && (OPERATORS as readonly string[]).includes(value);
}

/**
 * A pattern, compiled once: null when it is not valid, too long, or has the shape that backtracks without end (a repeated
 * group that is itself repeated). The engine is JavaScript's, not the linear-time one the server uses: the answer is the
 * same for the patterns a rule uses in practice, and a pattern only that engine accepts is refused here, never guessed.
 */
const patterns = new Map<string, { test(input: string): boolean } | null>();

export function pattern(source: string): { test(input: string): boolean } | null {
  const cached = patterns.get(source);
  if (cached !== undefined) return cached;
  let compiled: { test(input: string): boolean } | null;
  try {
    compiled = source.length > LIMITS.patternLength || /\([^)]*[+*][^)]*\)[+*{]/.test(source) ? null : new RegExp(source, "u");
  } catch {
    compiled = null;
  }
  if (patterns.size >= 500) patterns.clear();
  patterns.set(source, compiled);
  return compiled;
}

/** What an evaluation's caller tells it about fact names, which only it knows. */
export interface ConditionOptions {
  /** Facts compared without regard to case, such as a plan key typed by hand. @default none */
  readonly caseInsensitive?: ReadonlySet<string>;
}

const fold = (value: unknown): unknown => (typeof value === "string" ? value.toLowerCase() : value);

const numbers = (value: unknown, against: readonly ConditionValue[], count: number): number[] | null => {
  if (against.length < count) return null;
  const all = [Number(value), ...against.slice(0, count).map(Number)];
  return all.some(Number.isNaN) ? null : all;
};

/**
 * Whether one condition holds for a fact's value. Today's semantics
 * (auth-core `operators.ts`), with exact membership for a list fact
 * and `regex` on a pattern without look-around or back-references. Fail-safe: a malformed condition or input
 * never throws, it does not match.
 */
export function evaluateCondition(condition: Condition, given: unknown, options: ConditionOptions = {}): boolean {
  const { operator } = condition;
  const insensitive = options.caseInsensitive?.has(condition.attribute) === true;
  const values = insensitive ? (condition.values.map(fold) as ConditionValue[]) : condition.values;
  const value = insensitive ? fold(given) : given;

  if (operator === "exists") return value !== undefined && value !== null;
  if (operator === "not_exists") return value === undefined || value === null;
  if (value === undefined || value === null) return false;

  if (Array.isArray(value)) {
    const list = value as readonly unknown[];
    switch (operator) {
      case "contains":
        return values.length > 0 && list.includes(values[0]);
      case "not_contains":
        return values.length > 0 && !list.includes(values[0]);
      case "in":
        return values.length > 0 && values.length <= LIMITS.valuesPerCondition && list.some((item) => values.includes(item as ConditionValue));
      case "not_in":
        return values.length <= LIMITS.valuesPerCondition && !list.some((item) => values.includes(item as ConditionValue));
      default:
        break;
    }
  }

  switch (operator) {
    case "eq":
      return values.length > 0 && values[0] === value;
    case "neq":
      return values.length > 0 && values[0] !== value;
    case "contains":
      return values.length > 0 && String(value).includes(String(values[0]));
    case "not_contains":
      return values.length > 0 && !String(value).includes(String(values[0]));
    case "in":
      return values.length > 0 && values.length <= LIMITS.valuesPerCondition && values.includes(value as ConditionValue);
    case "not_in":
      return values.length <= LIMITS.valuesPerCondition && !values.includes(value as ConditionValue);
    case "gt": {
      const all = numbers(value, values, 1);
      return all !== null && (all[0] as number) > (all[1] as number);
    }
    case "lt": {
      const all = numbers(value, values, 1);
      return all !== null && (all[0] as number) < (all[1] as number);
    }
    case "between": {
      const all = numbers(value, values, 2);
      if (all === null) return false;
      const [n, a, b] = all as [number, number, number];
      return n >= Math.min(a, b) && n <= Math.max(a, b);
    }
    case "regex": {
      const input = String(value);
      if (values.length === 0 || input.length > LIMITS.factLength) return false;
      return pattern(String(values[0]))?.test(input) ?? false;
    }
    default: {
      const unknown: never = operator;
      void unknown;
      return false;
    }
  }
}

/** Why a condition cannot be saved, or null. */
export function conditionProblem(condition: Condition): string | null {
  if (typeof condition !== "object" || condition === null) return "A condition is an object.";
  if (typeof condition.attribute !== "string" || condition.attribute.length === 0 || condition.attribute.length > 200) return "A condition names a fact of 1 to 200 characters.";
  if (condition.attribute.split(".").length > LIMITS.pathDepth + 1) return `A fact's name has at most ${String(LIMITS.pathDepth)} dots.`;
  if (!isOperator(condition.operator)) return `Unknown operator "${String(condition.operator)}". Valid: ${OPERATORS.join(", ")}.`;
  if (!Array.isArray(condition.values)) return "A condition's values are a list.";
  if (condition.values.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) return "A condition's values are text, numbers, true, false or null.";
  const count = condition.values.length;
  switch (condition.operator) {
    case "between":
      return count === 2 ? null : `"between" takes exactly 2 values, got ${String(count)}.`;
    case "in":
    case "not_in":
      if (count === 0) return `"${condition.operator}" takes at least 1 value.`;
      return count > LIMITS.valuesPerCondition ? `"${condition.operator}" takes at most ${String(LIMITS.valuesPerCondition)} values, got ${String(count)}.` : null;
    case "exists":
    case "not_exists":
      return count === 0 ? null : `"${condition.operator}" takes no values, got ${String(count)}.`;
    case "regex": {
      if (count !== 1) return `"regex" takes exactly 1 value, got ${String(count)}.`;
      const source = String(condition.values[0]);
      if (source.length > LIMITS.patternLength) return `A pattern has at most ${String(LIMITS.patternLength)} characters.`;
      return pattern(source) === null ? `"${source}" is not a pattern this evaluator takes (no look-around or back-references).` : null;
    }
    default:
      return count === 1 ? null : `"${condition.operator}" takes exactly 1 value, got ${String(count)}.`;
  }
}
