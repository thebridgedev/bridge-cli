import type { Rule } from '@nebulr-group/bridge-auth-core';
import { getManagementClient } from './config.js';

/*
 * TBP-709 (C) — coherence warnings for feature flags.
 *
 * A flag can be saved in a state that cannot mean what it looks like: "on"
 * while its on-value is false, or a rule that targets a plan or role the app
 * does not have. Both used to come back as confident answers. These checks
 * add a `warnings` list to what `bridge flag …` prints; they never block a
 * write — the server stays authoritative, the warning informs.
 *
 * Port of bridge-api's MCP `mcp/tools/flag-coherence.ts`: same rules, same
 * words, same tests, so the CLI and the MCP flag tools warn identically.
 */

/** The fields a coherence check reads. Values as stored; defaults applied here. */
export interface FlagLike {
  key: string;
  state?: string;
  valueType?: string;
  onValue?: unknown;
  offValue?: unknown;
  rule?: Rule | null;
}

/** What the app actually has, for the dangling-reference check. */
export interface CoherenceCatalog {
  /** Every value a plan can be matched by: its key and its name. */
  plans: Array<{ key: string; name?: string }>;
  roles: Array<{ key: string; name?: string }>;
}

/** Attributes whose value names a plan (the JWT `plan` claim, billing slug). */
const PLAN_ATTRIBUTES = ['tenant.plan', 'bridge:billing.plan'];
/** Attributes whose value names a role (the JWT `role` claim). */
const ROLE_ATTRIBUTES = ['user.role'];
/** Operators whose values are compared for equality with the attribute. */
const EQUALITY_OPERATORS = ['eq', 'neq', 'in', 'not_in'];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function listed(entries: Array<{ key: string; name?: string }>): string {
  return entries.length ? entries.map((e) => e.key).join(', ') : '(none)';
}

/**
 * The warnings for one flag. Pure. `catalog` omitted skips the
 * dangling-reference check (the caller could not read plans/roles).
 */
export function flagCoherenceWarnings(flag: FlagLike, catalog?: CoherenceCatalog): string[] {
  const warnings: string[] = [];
  const state = flag.state ?? 'off';
  const valueType = flag.valueType ?? 'boolean';
  const onValue = flag.onValue !== undefined ? flag.onValue : true;
  const offValue = flag.offValue !== undefined ? flag.offValue : false;

  if (state === 'on') {
    if (valueType === 'boolean' && onValue === false) {
      warnings.push(
        `Flag "${flag.key}" is switched on, but its onValue is false, so it returns false for ` +
          'everyone: it looks on and behaves off. Set onValue to true, or switch the flag off.',
      );
    } else if (sameValue(onValue, offValue)) {
      warnings.push(
        `Flag "${flag.key}" is switched on, but its onValue equals its offValue ` +
          `(${JSON.stringify(onValue)}), so switching it on or off changes nothing.`,
      );
    }
  }

  if (catalog && flag.rule) {
    for (const branch of flag.rule.branches ?? []) {
      for (const condition of branch.conditions ?? []) {
        if (!EQUALITY_OPERATORS.includes(condition.operator)) continue;
        const isPlan = PLAN_ATTRIBUTES.includes(condition.attribute);
        const isRole = ROLE_ATTRIBUTES.includes(condition.attribute);
        if (!isPlan && !isRole) continue;
        const known = isPlan ? catalog.plans : catalog.roles;
        const names = new Set<string>();
        for (const k of known) {
          names.add(k.key);
          if (k.name) names.add(k.name);
        }
        for (const value of condition.values ?? []) {
          if (typeof value !== 'string' || names.has(value)) continue;
          const what = isPlan ? 'plan' : 'role';
          warnings.push(
            `Flag "${flag.key}" has a rule on ${condition.attribute} ${condition.operator} ` +
              `"${value}", but the app has no ${what} "${value}", so no real ` +
              `${isPlan ? 'workspace' : 'user'} can carry it. Existing ${what} keys: ` +
              `${listed(known)}.`,
          );
        }
      }
    }
  }

  return warnings;
}

/** True when any condition reads a plan or role attribute (worth fetching the catalog). */
export function ruleReadsPlanOrRole(rule: Rule | null | undefined): boolean {
  if (!rule) return false;
  return (rule.branches ?? []).some((b) =>
    (b.conditions ?? []).some(
      (c) => PLAN_ATTRIBUTES.includes(c.attribute) || ROLE_ATTRIBUTES.includes(c.attribute),
    ),
  );
}

/**
 * Plans and roles for the dangling-reference check. Never throws: a login
 * that cannot read plans or roles gets no dangling-reference warning rather
 * than a failed flag command — a warning never blocks.
 */
export async function loadCoherenceCatalog(): Promise<CoherenceCatalog | undefined> {
  try {
    const client = getManagementClient();
    const [plans, roles] = await Promise.all([client.plans.list(), client.roles.list()]);
    return {
      plans: (plans ?? []).map((p) => ({ key: String(p.key), name: p.name })),
      roles: (roles ?? []).map((r) => ({ key: String(r.key), name: r.name })),
    };
  } catch {
    return undefined;
  }
}

/** Warnings for a list of flags, fetching the catalog once and only if a rule needs it. */
export async function warningsForFlags(flags: FlagLike[]): Promise<string[][]> {
  const catalog = flags.some((f) => ruleReadsPlanOrRole(f.rule)) ? await loadCoherenceCatalog() : undefined;
  return flags.map((f) => flagCoherenceWarnings(f, catalog));
}

/** A flag with its warnings attached — only when there are any, so a coherent flag prints as before. */
export async function withFlagWarnings<T extends FlagLike>(flag: T): Promise<T | (T & { warnings: string[] })> {
  if (!flag || typeof flag !== 'object') return flag;
  const [warnings] = await warningsForFlags([flag]);
  return warnings.length ? { ...flag, warnings } : flag;
}
