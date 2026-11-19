import { bucketOf, inRollout } from "./bucketing.js";
import { isOffValue, type Branch, type Condition, type EvaluationContext, type FactFamily, type FlagDefinition, type OffReason, type Resolution, type Rule, type SegmentDefinition } from "./model.js";
import { evaluateCondition, LIMITS, type ConditionOptions } from "./operators.js";

/**
 * What the caller of an evaluation knows that the evaluator does not: the
 * app's segments, and its own table of fact names. a caller gives its own or none.
 */
export interface EvaluationOptions extends ConditionOptions {
  /** The app's segments, by key. */
  readonly segments?: ReadonlyMap<string, SegmentDefinition>;
  /** Which family a fact belongs to, to say why a value is off. @default every fact is "other" */
  readonly family?: (fact: string) => FactFamily;
  /** The entitlement a plan fact asks for, to name it when a plan keeps a value off. @default none */
  readonly entitlement?: (fact: string) => string | undefined;
}

/** The context key OpenFeature buckets by when a rule names no `bucketBy`. */
export const TARGETING_KEY = "targetingKey";

/**
 * A fact's value in a context: the flat name first (`user.role`), then the
 * name walked as a path (`user` then `role`).
 */
export function resolveFact(context: EvaluationContext, name: string): unknown {
  if (Object.hasOwn(context, name)) return context[name];
  let current: unknown = context;
  for (const part of name.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Why a context cannot be evaluated, or null: too many facts, or one too large. */
export function contextProblem(context: EvaluationContext): string | null {
  let facts = 0;
  const visit = (value: unknown, depth: number): string | null => {
    if (++facts > LIMITS.contextFacts) return `A context holds at most ${String(LIMITS.contextFacts)} facts.`;
    if (typeof value === "string" && value.length > LIMITS.factLength) return `A fact holds at most ${String(LIMITS.factLength)} characters.`;
    if (Array.isArray(value)) return value.length > LIMITS.listLength ? `A list fact holds at most ${String(LIMITS.listLength)} items.` : value.every((item) => item === null || typeof item !== "object") ? null : "A list fact holds plain values.";
    if (value !== null && typeof value === "object") {
      if (depth >= LIMITS.pathDepth) return `Facts nest at most ${String(LIMITS.pathDepth)} deep.`;
      for (const each of Object.values(value)) {
        const problem = visit(each, depth + 1);
        if (problem !== null) return problem;
      }
    }
    return null;
  };
  for (const value of Object.values(context)) {
    const problem = visit(value, 0);
    if (problem !== null) return problem;
  }
  return null;
}

class OutOfSteps extends Error {}

/** One evaluation's step budget: every condition checked counts, a segment's included. */
class Steps {
  private left: number = LIMITS.steps;
  take(): void {
    if (--this.left < 0) throw new OutOfSteps("The evaluation ran out of steps.");
  }
}

const RANK: Readonly<Record<OffReason, number>> = { plan: 0, permission: 1, rule: 2, off: 3, rollout: 4 };

/** Every condition a branch needs: its own, then its segments', in order. A segment that does not exist never matches. */
function conditionsOf(branch: Branch, options: EvaluationOptions): readonly Condition[] | null {
  const all = [...branch.conditions];
  for (const key of branch.segments ?? []) {
    const segment = options.segments?.get(key);
    if (segment === undefined) return null;
    all.push(...segment.conditions);
  }
  return all;
}

function holds(condition: Condition, context: EvaluationContext, options: EvaluationOptions, steps: Steps): boolean {
  steps.take();
  return evaluateCondition(condition, resolveFact(context, condition.attribute), options);
}

function reasonOf(families: ReadonlySet<FactFamily>): OffReason {
  if (families.size === 0 || families.has("other")) return "rule";
  return families.has("permission") ? "permission" : "plan";
}

function why(reason: OffReason, conditions: readonly Condition[], options: EvaluationOptions): Record<string, string> {
  if (reason !== "plan") return { why: reason };
  for (const condition of conditions) {
    const entitlement = options.entitlement?.(condition.attribute);
    if (entitlement !== undefined && entitlement !== "") return { why: reason, entitlement };
  }
  return { why: reason };
}

/**
 * Why a rule served an off value : the branch that
 * gave it decides by its own conditions' families; when the otherwise value
 * was served, each branch that would have turned it on is asked which of its
 * conditions failed, and the most hopeful answer wins (an upgrade alone
 * opens it: `plan`; else `permission`; else `rule`). A person a rollout
 * left out, with nothing else matching, is `rollout`.
 */
function explainOff(rule: Rule, context: EvaluationContext, given: number, leftOut: boolean, options: EvaluationOptions, steps: Steps): Record<string, string> {
  const family = options.family ?? (() => "other" as const);
  if (given >= 0) {
    const conditions = conditionsOf(rule.branches[given] as Branch, options) ?? [];
    return why(reasonOf(new Set(conditions.map((each) => family(each.attribute)))), conditions, options);
  }
  if (leftOut) return { why: "rollout" };
  let best: { reason: OffReason; failed: Condition[] } | undefined;
  for (const branch of rule.branches) {
    if (isOffValue(branch.returnValue)) continue;
    const conditions = conditionsOf(branch, options) ?? [];
    if (conditions.length === 0) continue;
    const failed = conditions.filter((each) => !holds(each, context, options, steps));
    if (failed.length === 0) continue;
    const reason = reasonOf(new Set(failed.map((each) => family(each.attribute))));
    if (best === undefined || RANK[reason] < RANK[best.reason]) best = { reason, failed };
  }
  return best === undefined ? { why: "rule" } : why(best.reason, best.failed, options);
}

/** The value a rule's rollouts bucket by: the named fact, else the targeting key; null when there is none. */
function bucketingValue(rule: Rule, context: EvaluationContext): string | null {
  const value = resolveFact(context, rule.bucketBy ?? TARGETING_KEY);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

function runRule(flag: FlagDefinition, rule: Rule, context: EvaluationContext, options: EvaluationOptions, steps: Steps): Resolution {
  let bucket: number | null | undefined;
  let leftOut = false;
  for (const [index, branch] of rule.branches.entries()) {
    const conditions = conditionsOf(branch, options);
    if (conditions === null || conditions.length === 0) continue;
    if (!conditions.every((each) => holds(each, context, options, steps))) continue;
    const pct = branch.rolloutPct ?? rule.rolloutPct ?? 100;
    if (pct < 100) {
      if (bucket === undefined) {
        const value = bucketingValue(rule, context);
        bucket = value === null ? null : bucketOf(flag.salt ?? flag.key, value);
      }
      // Without a bucketing value, no one is inside a partial rollout: they go on to the next branch.
      if (bucket === null || !inRollout(bucket, pct)) {
        leftOut = true;
        continue;
      }
    }
    const value = branch.returnValue;
    return {
      key: flag.key,
      value,
      variant: `rule-${String(index)}`,
      reason: "TARGETING_MATCH",
      metadata: isOffValue(value) ? explainOff(rule, context, index, false, options, steps) : {},
      variantIndex: index,
      matched: true,
    };
  }
  const value = rule.otherwiseValue;
  return {
    key: flag.key,
    value,
    variant: "otherwise",
    reason: "TARGETING_MATCH",
    metadata: isOffValue(value) ? explainOff(rule, context, -1, leftOut, options, steps) : {},
    variantIndex: -1,
    matched: false,
  };
}

/**
 * The answer for one flag and one context: the value, its variant, the
 * reason, and why an off value is off. Never throws: a context over the
 * limits, or an evaluation over its step budget, answers an error with the
 * off value.
 */
export function evaluateFlag(flag: FlagDefinition, context: EvaluationContext, options: EvaluationOptions = {}): Resolution {
  const failed = (errorCode: Resolution["errorCode"] & string, errorDetails: string): Resolution => ({
    key: flag.key,
    value: flag.offValue,
    variant: "off",
    reason: "ERROR",
    errorCode,
    errorDetails,
    metadata: {},
    variantIndex: -1,
    matched: false,
  });
  if (flag.state === "off") {
    return { key: flag.key, value: flag.offValue, variant: "off", reason: "DISABLED", metadata: isOffValue(flag.offValue) ? { why: "off" } : {}, variantIndex: -1, matched: false };
  }
  if (flag.state === "on" || flag.rule === undefined || flag.rule === null) {
    return { key: flag.key, value: flag.onValue, variant: "on", reason: "STATIC", metadata: {}, variantIndex: 0, matched: true };
  }
  const problem = contextProblem(context);
  if (problem !== null) return failed("INVALID_CONTEXT", problem);
  try {
    return runRule(flag, flag.rule, context, options, new Steps());
  } catch (error) {
    if (error instanceof OutOfSteps) return failed("GENERAL", error.message);
    return failed("GENERAL", "The rule could not be evaluated.");
  }
}

/** Every flag's answer for one context. */
export function evaluateFlags(flags: Iterable<FlagDefinition>, context: EvaluationContext, options: EvaluationOptions = {}): Resolution[] {
  return [...flags].map((flag) => evaluateFlag(flag, context, options));
}
