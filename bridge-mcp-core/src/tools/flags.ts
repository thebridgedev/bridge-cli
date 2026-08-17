import { z } from 'zod';
import { OPERATORS, validateRule } from '@nebulr-group/bridge-auth-core';
import type {
  CreateFlagInput,
  Rule,
  UpdateFlagInput,
} from '@nebulr-group/bridge-auth-core';
import type { BridgeToolDefinition, ToolResult } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Read-only list of every feature flag with its full targeting setup.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the canonical empty Zod raw shape
export const listFeatureFlagsTool: BridgeToolDefinition<{}> = {
  name: 'list_feature_flags',
  description:
    'List every feature flag in the Bridge app with its full targeting rules and state. ' +
    'Each flag includes: key, description, lifecycle state (on/off/conditional), value ' +
    'type and on/off values, the FF 2.0 targeting rule tree, legacy segments, any ' +
    'scheduled state transition, and evaluation stats (evalCount, lastEvalAt). Use this ' +
    'when working with flags — verifying a flag key exists before referencing it in ' +
    'code, or inspecting targeting before relying on a flag. For app-level auth/config ' +
    'use get_app or get_auth_config instead; for project wiring use get_environment_info.',
  inputSchema: {},
  handler: async (ctx) => {
    try {
      const flags = await ctx.management.flags.list();
      return { success: true, data: { flags } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

// ── FF 2.0 rule schema (structured, canonical auth-core shape) ──────────────
//
// Mirrors what the CLI's `flag create/update --rule <json>` accepts, except
// legacy operator aliases (`equals`, `starts_with`, `gte`, …) are NOT accepted
// here — MCP input is structured and authored fresh, so only the locked
// canonical operator vocabulary is valid. Semantic validation (operator/type
// compatibility, rollout bounds, groupRef-vs-branches exclusivity) is done in
// the handler by auth-core's `validateRule` — the same validator the CLI runs.

const conditionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const conditionSchema = z.object({
  attribute: z
    .string()
    .min(1, 'condition.attribute must be a non-empty attribute path, e.g. "tenant.plan" or "user.email".'),
  operator: z.enum(OPERATORS),
  values: z
    .array(conditionValueSchema)
    .describe(
      'Comparison values (always a plural array, even for single-value operators like eq). ' +
        'For between: [min, max]. For exists/not_exists: [].',
    ),
});

const branchSchema = z
  .object({
    conditions: z
      .array(conditionSchema)
      .describe('Conditions AND-ed together; the branch matches when all hold.'),
    returnValue: z
      .unknown()
      .describe('Value the flag returns when this branch matches (typed per the flag valueType).'),
  })
  .superRefine((b, ctx) => {
    if (b.returnValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Branch is missing returnValue — the value the flag evaluates to when the branch matches.',
      });
    }
  });

/**
 * Zod mirror of the canonical auth-core `Rule` shape. Exported for tests.
 */
export const ruleSchema = z
  .object({
    branches: z
      .array(branchSchema)
      .default([])
      .describe('Ordered branches, first-match-wins.'),
    otherwiseValue: z
      .unknown()
      .describe('Value returned when no branch matches (or the identity is excluded by rollout).'),
    rolloutPct: z
      .number()
      .min(0, 'rolloutPct must be in [0, 100].')
      .max(100, 'rolloutPct must be in [0, 100].')
      .default(100)
      .describe('0-100; applies to the whole rule. Defaults to 100 (full rollout).'),
    groupRef: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to a saved condition group; mutually exclusive with inline branches.'),
  })
  .superRefine((r, ctx) => {
    if (r.otherwiseValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rule is missing otherwiseValue — the value returned when no branch matches.',
      });
    }
  });

const FLAG_STATE = z
  .enum(['off', 'on', 'on-with-rule'])
  .describe(
    'Three-state model: off (always offValue), on (always onValue), on-with-rule (evaluate rule).',
  );

const FLAG_VALUE_TYPE = z
  .enum(['boolean', 'string', 'number', 'json'])
  .describe('Type of the values this flag returns.');

/**
 * Run auth-core's canonical rule validator; null when valid, failure envelope
 * when not. Shared by create_feature_flag / update_feature_flag.
 */
function validateRuleOrFail(rule: Rule): ToolResult | null {
  const errors = validateRule(rule);
  if (errors.length === 0) return null;
  return {
    success: false,
    error: {
      code: 'INVALID_RULE',
      message: `Rule failed validation: ${errors.map((e) => e.message).join(' ')}`,
      fix:
        `Fix the rule and retry. Canonical operators: ${OPERATORS.join(', ')}. ` +
        'Every branch needs at least one condition; rolloutPct must be 0-100; ' +
        'a rule cannot carry both inline branches and a groupRef.',
    },
  };
}

const RULE_ARG_DESCRIPTION =
  'Structured FF 2.0 targeting rule: { branches: [{ conditions: [{ attribute, operator, values }], ' +
  'returnValue }], otherwiseValue, rolloutPct?, groupRef? }. Branches are first-match-wins; ' +
  'conditions in a branch are AND-ed. Example: target the Pro plan with ' +
  '{ "branches": [{ "conditions": [{ "attribute": "tenant.plan", "operator": "eq", ' +
  '"values": ["Pro"] }], "returnValue": true }], "otherwiseValue": false }. IMPORTANT: plans are ' +
  'referenced by plan NAME (the `name` field from list_plans, e.g. "Pro"), not by plan key.';

/**
 * Create a feature flag with the full FF 2.0 shape.
 */
export const createFeatureFlagTool: BridgeToolDefinition<{
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  state: z.ZodOptional<typeof FLAG_STATE>;
  valueType: z.ZodOptional<typeof FLAG_VALUE_TYPE>;
  onValue: z.ZodOptional<z.ZodUnknown>;
  offValue: z.ZodOptional<z.ZodUnknown>;
  rule: z.ZodOptional<typeof ruleSchema>;
}> = {
  name: 'create_feature_flag',
  description:
    'Create a new feature flag (FF 2.0 shape). Arguments: key (required — the identifier ' +
    'code reads, e.g. "beta-ui"), description, state (off | on | on-with-rule; server ' +
    'defaults to off), valueType (boolean | string | number | json; defaults to boolean), ' +
    'onValue / offValue (the typed values returned in the on / off states — pass real JSON ' +
    'values, e.g. true, "variant-b", 42, or an object), and an optional structured rule for ' +
    'state=on-with-rule. ' +
    RULE_ARG_DESCRIPTION +
    ' Use update_feature_flag to change an existing flag, and toggle_feature_flag for a ' +
    'quick on/off switch by key.',
  inputSchema: {
    key: z.string().min(1, 'key must be a non-empty flag key, e.g. "beta-ui".'),
    description: z.string().optional(),
    state: FLAG_STATE.optional(),
    valueType: FLAG_VALUE_TYPE.optional(),
    onValue: z.unknown().optional().describe('Value returned when state=on (typed per valueType).'),
    offValue: z.unknown().optional().describe('Value returned when state=off (typed per valueType).'),
    rule: ruleSchema.optional().describe(RULE_ARG_DESCRIPTION),
  },
  handler: async (ctx, args) => {
    try {
      const payload: CreateFlagInput = { key: args.key as string };
      if (args.description !== undefined) payload.description = args.description as string;
      if (args.state !== undefined) payload.state = args.state as CreateFlagInput['state'];
      if (args.valueType !== undefined) {
        payload.valueType = args.valueType as CreateFlagInput['valueType'];
      }
      if (args.onValue !== undefined) payload.onValue = args.onValue;
      if (args.offValue !== undefined) payload.offValue = args.offValue;
      if (args.rule !== undefined) {
        const rule = args.rule as Rule;
        const invalid = validateRuleOrFail(rule);
        if (invalid) return invalid;
        payload.rule = rule;
      }
      const flag = await ctx.management.flags.create(payload);
      return { success: true, data: flag };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Update an existing feature flag by id (FF 2.0 shape).
 */
export const updateFeatureFlagTool: BridgeToolDefinition<{
  id: z.ZodString;
  key: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  state: z.ZodOptional<typeof FLAG_STATE>;
  valueType: z.ZodOptional<typeof FLAG_VALUE_TYPE>;
  onValue: z.ZodOptional<z.ZodUnknown>;
  offValue: z.ZodOptional<z.ZodUnknown>;
  rule: z.ZodOptional<typeof ruleSchema>;
  clearRule: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'update_feature_flag',
  description:
    'Update an existing feature flag by its id (get the id from list_feature_flags). Only the ' +
    'fields you pass are changed. Fields: key, description, state (off | on | on-with-rule), ' +
    'valueType (boolean | string | number | json), onValue / offValue (typed JSON values), ' +
    'rule (structured — replaces the whole rule), clearRule: true to remove the rule entirely. ' +
    RULE_ARG_DESCRIPTION +
    ' For a plain on/off switch prefer toggle_feature_flag, which works by key.',
  inputSchema: {
    id: z.string().min(1, 'id must be the flag id from list_feature_flags.'),
    key: z.string().min(1).optional(),
    description: z.string().optional(),
    state: FLAG_STATE.optional(),
    valueType: FLAG_VALUE_TYPE.optional(),
    onValue: z.unknown().optional().describe('Value returned when state=on (typed per valueType).'),
    offValue: z.unknown().optional().describe('Value returned when state=off (typed per valueType).'),
    rule: ruleSchema.optional().describe(RULE_ARG_DESCRIPTION),
    clearRule: z.boolean().optional().describe('true removes the existing rule (sets it to null).'),
  },
  handler: async (ctx, args) => {
    try {
      const payload: UpdateFlagInput = {};
      if (args.key !== undefined) payload.key = args.key as string;
      if (args.description !== undefined) payload.description = args.description as string;
      if (args.state !== undefined) payload.state = args.state as UpdateFlagInput['state'];
      if (args.valueType !== undefined) {
        payload.valueType = args.valueType as UpdateFlagInput['valueType'];
      }
      if (args.onValue !== undefined) payload.onValue = args.onValue;
      if (args.offValue !== undefined) payload.offValue = args.offValue;
      if (args.rule !== undefined) {
        const rule = args.rule as Rule;
        const invalid = validateRuleOrFail(rule);
        if (invalid) return invalid;
        payload.rule = rule;
      }
      if (args.clearRule === true) payload.rule = null;
      const flag = await ctx.management.flags.update(args.id as string, payload);
      return { success: true, data: flag };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Quick on/off toggle by flag KEY (resolves the id internally).
 */
export const toggleFeatureFlagTool: BridgeToolDefinition<{
  key: z.ZodString;
  enabled: z.ZodBoolean;
}> = {
  name: 'toggle_feature_flag',
  description:
    'Quick-toggle a feature flag on or off by its KEY (no id lookup needed — this tool ' +
    'resolves it). enabled: true turns the flag on, false turns it off. Does not touch the ' +
    "flag's rule, values or schedule — for those use update_feature_flag. Fails with " +
    'FLAG_NOT_FOUND when no flag has the given key.',
  inputSchema: {
    key: z.string().min(1, 'key must be a non-empty flag key, e.g. "beta-ui".'),
    enabled: z.boolean().describe('true = on, false = off.'),
  },
  handler: async (ctx, args) => {
    try {
      const all = await ctx.management.flags.list();
      const found = all.find((f) => f.key === args.key);
      if (!found) {
        return {
          success: false,
          error: {
            code: 'FLAG_NOT_FOUND',
            message: `Flag not found: ${args.key}`,
            fix: 'Call list_feature_flags to see the existing flag keys, or create_feature_flag to create it.',
          },
        };
      }
      const flag = await ctx.management.flags.toggle(found.id, args.enabled as boolean);
      return { success: true, data: flag };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
