/**
 * TBP-192 / TBP-236 — Unit tests for the FF 2.0 flag command helpers.
 *
 * Covers:
 *   - coerceValue() — boolean / number / string / json
 *   - buildFlagWritePayload() — happy path + invalid state + invalid valueType
 *   - parseRuleArg() — happy path + invalid JSON + missing otherwiseValue +
 *     unknown operator rejection
 *   - normalizeRuleInput() — legacy → canonical migration (TBP-236):
 *     scalar `value` → plural `values`, legacy operator names shimmed to the
 *     locked auth-core vocabulary with a deprecation warning on stderr
 *   - parseAttributes() — key=value pairs with JSON coercion
 *   - validateRule() — the canonical auth-core validator (re-exported):
 *     rejects branch with no conditions; rejects bad rolloutPct
 *   - evaluateLocally() — state=off, state=on, state=on-with-rule
 *     (match + otherwise + rollout) via the canonical auth-core evaluator
 */

// Mock the auth-core package entry (its full index pulls in the whole SDK
// graph, which the CJS test runtime doesn't need), but wire the REAL canonical
// operators + evaluator modules through so these tests exercise auth-core's
// actual rule semantics. The dist files are ESM; jest.config.cjs transforms
// @nebulr-group files to CJS via ts-jest (allowJs).
jest.mock('@nebulr-group/bridge-auth-core', () => {
  // Resolve the package's real location rather than assuming a relative
  // node_modules path: npm workspaces hoist deps to the repo root in CI, so
  // '../../node_modules/...' exists locally but not there. The exports map
  // only publishes '.' and './backend', so deep specifiers can't be resolved
  // directly — derive dist/ from the resolved entry point instead.
  const path = require('path');
  const distDir = path.dirname(require.resolve('@nebulr-group/bridge-auth-core'));
  const operators = jest.requireActual(path.join(distDir, 'flags/operators.js'));
  const evaluator = jest.requireActual(path.join(distDir, 'flags/evaluator.js'));
  return {
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
    ...operators,
    ...evaluator,
  };
});

import {
  coerceValue,
  buildFlagWritePayload,
  parseRuleArg,
  parseAttributes,
  normalizeRuleInput,
  validateRule,
  evaluateLocally,
} from '../commands/flag.command';

describe('coerceValue', () => {
  it('coerces booleans', () => {
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('false', 'boolean')).toBe(false);
  });

  it('throws on invalid boolean', () => {
    expect(() => coerceValue('maybe', 'boolean')).toThrow(/Invalid boolean/);
  });

  it('coerces numbers', () => {
    expect(coerceValue('42', 'number')).toBe(42);
    expect(coerceValue('3.14', 'number')).toBe(3.14);
  });

  it('throws on invalid number', () => {
    expect(() => coerceValue('abc', 'number')).toThrow(/Invalid number/);
  });

  it('passes strings through', () => {
    expect(coerceValue('hello', 'string')).toBe('hello');
  });

  it('parses json', () => {
    expect(coerceValue('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(coerceValue('[1,2,3]', 'json')).toEqual([1, 2, 3]);
  });

  it('throws on invalid json', () => {
    expect(() => coerceValue('{not-json', 'json')).toThrow(/Invalid JSON/);
  });
});

describe('buildFlagWritePayload', () => {
  it('builds a 2.0 payload from typed options', () => {
    const payload = buildFlagWritePayload({
      key: 'new-checkout',
      description: 'New checkout',
      state: 'on',
      valueType: 'boolean',
      onValue: 'true',
      offValue: 'false',
    });
    expect(payload).toEqual({
      key: 'new-checkout',
      description: 'New checkout',
      state: 'on',
      valueType: 'boolean',
      onValue: true,
      offValue: false,
    });
  });

  it('handles a json-typed flag', () => {
    const payload = buildFlagWritePayload({
      key: 'limits',
      valueType: 'json',
      onValue: '{"seats":10}',
      offValue: '{"seats":1}',
    });
    expect(payload.valueType).toBe('json');
    expect(payload.onValue).toEqual({ seats: 10 });
    expect(payload.offValue).toEqual({ seats: 1 });
  });

  it('rejects an invalid state', () => {
    expect(() =>
      buildFlagWritePayload({ key: 'x', state: 'maybe' }),
    ).toThrow(/Invalid --state/);
  });

  it('rejects an invalid value-type', () => {
    expect(() =>
      buildFlagWritePayload({ key: 'x', valueType: 'date' }),
    ).toThrow(/Invalid --value-type/);
  });

  it('parses and includes a valid rule', () => {
    const ruleJson = JSON.stringify({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    const payload = buildFlagWritePayload({ key: 'x', state: 'on-with-rule', rule: ruleJson });
    expect(payload.rule).toMatchObject({
      otherwiseValue: false,
      rolloutPct: 100,
    });
  });

  it('does not emit legacy boolean defaults in partial (update) mode', () => {
    // Commander returns `false` as the default for option flags. In update mode
    // those would otherwise clobber server state on every call.
    const payload = buildFlagWritePayload({ key: 'x' }, { partial: true });
    expect(payload).not.toHaveProperty('enabled');
    expect(payload).not.toHaveProperty('defaultValue');
  });
});

describe('parseRuleArg', () => {
  it('parses a valid canonical rule', () => {
    const rule = parseRuleArg(
      JSON.stringify({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
        rolloutPct: 50,
      }),
    );
    expect(rule.branches).toHaveLength(1);
    expect(rule.rolloutPct).toBe(50);
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'plan',
      operator: 'eq',
      values: ['pro'],
    });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseRuleArg('{ not json')).toThrow(/--rule must be valid JSON/);
  });

  it('rejects a rule missing otherwiseValue', () => {
    expect(() =>
      parseRuleArg(
        JSON.stringify({
          branches: [
            {
              conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
              returnValue: true,
            },
          ],
        }),
      ),
    ).toThrow(/otherwiseValue/);
  });

  it('rejects an unknown operator', () => {
    expect(() =>
      parseRuleArg(
        JSON.stringify({
          branches: [
            {
              conditions: [{ attribute: 'plan', operator: 'wat', values: ['pro'] }],
              returnValue: true,
            },
          ],
          otherwiseValue: false,
          rolloutPct: 100,
        }),
      ),
    ).toThrow(/Unknown operator "wat"/);
  });

  it('defaults rolloutPct to 100 when omitted', () => {
    const rule = parseRuleArg(
      JSON.stringify({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
      }),
    );
    expect(rule.rolloutPct).toBe(100);
  });
});

describe('normalizeRuleInput — legacy compatibility shim (TBP-236)', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const stderrOutput = () =>
    stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

  it('migrates scalar `value` to a plural `values` array (silently)', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'plan',
      operator: 'eq',
      values: ['pro'],
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('migrates an array `value` (legacy in/not_in) to `values`', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'in', value: ['pro', 'enterprise'] }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0].values).toEqual(['pro', 'enterprise']);
  });

  it('maps `equals` → `eq` and warns on stderr', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'plan',
      operator: 'eq',
      values: ['pro'],
    });
    expect(stderrOutput()).toMatch(/"equals" is deprecated; mapped to "eq"/);
  });

  it('maps `not_equals` → `neq` with a warning', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'not_equals', value: 'free' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0].operator).toBe('neq');
    expect(stderrOutput()).toMatch(/"not_equals" is deprecated; mapped to "neq"/);
  });

  it('maps `lessThan` → `lt` and `greaterThan` → `gt` with warnings', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [
            { attribute: 'seats', operator: 'lessThan', value: 10 },
            { attribute: 'seats', operator: 'greaterThan', value: 2 },
          ],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'seats',
      operator: 'lt',
      values: [10],
    });
    expect(rule.branches[0].conditions[1]).toEqual({
      attribute: 'seats',
      operator: 'gt',
      values: [2],
    });
    expect(stderrOutput()).toMatch(/"lessThan" is deprecated/);
    expect(stderrOutput()).toMatch(/"greaterThan" is deprecated/);
  });

  it('rewrites `starts_with` to an anchored regex with a warning', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'email', operator: 'starts_with', value: 'admin.' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'email',
      operator: 'regex',
      values: ['^admin\\.'],
    });
    expect(stderrOutput()).toMatch(/"starts_with" is deprecated; mapped to "regex"/);
  });

  it('rewrites `ends_with` to an anchored regex with a warning', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'email', operator: 'ends_with', value: '@acme.com' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'email',
      operator: 'regex',
      values: ['@acme\\.com$'],
    });
    expect(stderrOutput()).toMatch(/"ends_with" is deprecated; mapped to "regex"/);
  });

  it('rewrites `gte` / `lte` to `between` with warnings', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [
            { attribute: 'seats', operator: 'gte', value: 5 },
            { attribute: 'seats', operator: 'lte', value: 50 },
          ],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'seats',
      operator: 'between',
      values: [5, Number.MAX_VALUE],
    });
    expect(rule.branches[0].conditions[1]).toEqual({
      attribute: 'seats',
      operator: 'between',
      values: [-Number.MAX_VALUE, 50],
    });
    expect(stderrOutput()).toMatch(/"gte" is deprecated; mapped to "between"/);
    expect(stderrOutput()).toMatch(/"lte" is deprecated; mapped to "between"/);
  });

  it('accepts a legacy rule end-to-end via parseRuleArg', () => {
    const rule = parseRuleArg(
      JSON.stringify({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
        rolloutPct: 100,
      }),
    );
    expect(rule.branches[0].conditions[0]).toEqual({
      attribute: 'plan',
      operator: 'eq',
      values: ['pro'],
    });
    expect(stderrOutput()).toMatch(/deprecated/);
  });

  it('leaves canonical operators untouched (no warning)', () => {
    const rule = normalizeRuleInput({
      branches: [
        {
          conditions: [
            { attribute: 'plan', operator: 'in', values: ['pro', 'enterprise'] },
            { attribute: 'region', operator: 'not_exists', values: [] },
          ],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(rule.branches[0].conditions[0].operator).toBe('in');
    expect(rule.branches[0].conditions[1].operator).toBe('not_exists');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('throws on structurally invalid input', () => {
    expect(() => normalizeRuleInput('nope')).toThrow(/Rule must be an object/);
    expect(() =>
      normalizeRuleInput({
        branches: [{ conditions: [{ operator: 'eq', values: ['x'] }], returnValue: true }],
        otherwiseValue: false,
      }),
    ).toThrow(/missing 'attribute'/);
    expect(() =>
      normalizeRuleInput({
        branches: [{ conditions: [{ attribute: 'plan', values: ['x'] }], returnValue: true }],
        otherwiseValue: false,
      }),
    ).toThrow(/missing 'operator'/);
    expect(() =>
      normalizeRuleInput({
        branches: [{ conditions: [{ attribute: 'plan', operator: 'eq', values: ['x'] }] }],
        otherwiseValue: false,
      }),
    ).toThrow(/missing returnValue/);
  });
});

describe('validateRule (canonical, re-exported from auth-core)', () => {
  it('returns no errors for a valid rule', () => {
    expect(
      validateRule({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
        rolloutPct: 100,
      }),
    ).toEqual([]);
  });

  it('flags a branch with no conditions', () => {
    const errs = validateRule({
      branches: [{ conditions: [], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(errs.some((e) => /no conditions/.test(e.message))).toBe(true);
  });

  it('flags an out-of-range rolloutPct', () => {
    const errs = validateRule({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 150,
    });
    expect(errs.some((e) => /rolloutPct/.test(e.message))).toBe(true);
  });

  it('flags an unknown operator', () => {
    const errs = validateRule({
      branches: [
        {
          // Deliberately bypass the type system — validating untrusted input.
          conditions: [{ attribute: 'plan', operator: 'equals', values: ['pro'] } as never],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(errs.some((e) => /Unknown operator/.test(e.message))).toBe(true);
  });
});

describe('parseAttributes', () => {
  it('parses key=value pairs with JSON coercion', () => {
    expect(parseAttributes(['plan=pro', 'seats=10', 'beta=true'])).toEqual({
      plan: 'pro',
      seats: 10,
      beta: true,
    });
  });

  it('rejects malformed entries', () => {
    expect(() => parseAttributes(['no-equals'])).toThrow(/expected key=value/);
  });
});

describe('evaluateLocally (canonical auth-core evaluator)', () => {
  it('returns offValue when state is off', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'off',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
      { attributes: {} },
    );
    expect(result.value).toBe(false);
    expect(result.matched).toBe(false);
  });

  it('returns onValue when state is on', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
      { attributes: {} },
    );
    expect(result.value).toBe(true);
    expect(result.matched).toBe(true);
  });

  it('matches a branch on eq', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on-with-rule',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
        rule: {
          branches: [
            {
              conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
              returnValue: true,
            },
          ],
          otherwiseValue: false,
          rolloutPct: 100,
        },
      },
      { identity: 'u-1', attributes: { plan: 'pro' } },
    );
    expect(result.value).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.variantIndex).toBe(0);
  });

  it('matches a branch on in with plural values', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on-with-rule',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
        rule: {
          branches: [
            {
              conditions: [
                { attribute: 'plan', operator: 'in', values: ['pro', 'enterprise'] },
              ],
              returnValue: true,
            },
          ],
          otherwiseValue: false,
          rolloutPct: 100,
        },
      },
      { identity: 'u-1', attributes: { plan: 'enterprise' } },
    );
    expect(result.value).toBe(true);
    expect(result.matched).toBe(true);
  });

  it('returns otherwiseValue when no branch matches', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on-with-rule',
        valueType: 'string',
        offValue: 'off',
        onValue: 'on',
        rule: {
          branches: [
            {
              conditions: [{ attribute: 'plan', operator: 'eq', values: ['enterprise'] }],
              returnValue: 'enterprise',
            },
          ],
          otherwiseValue: 'free',
          rolloutPct: 100,
        },
      },
      { identity: 'u-1', attributes: { plan: 'pro' } },
    );
    expect(result.value).toBe('free');
    expect(result.matched).toBe(false);
  });

  it('returns otherwiseValue when rollout excludes a user without identity', () => {
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on-with-rule',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
        rule: {
          branches: [
            {
              conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
              returnValue: true,
            },
          ],
          otherwiseValue: false,
          rolloutPct: 50,
        },
      },
      { attributes: { plan: 'pro' } }, // no identity
    );
    expect(result.excludedByRollout).toBe(true);
    expect(result.value).toBe(false);
  });

  it('evaluates a shimmed legacy rule identically to a canonical one', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const legacy = normalizeRuleInput({
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
          returnValue: 'legacy-match',
        },
      ],
      otherwiseValue: 'no-match',
      rolloutPct: 100,
    });
    const result = evaluateLocally(
      {
        key: 'x',
        state: 'on-with-rule',
        valueType: 'string',
        offValue: 'off',
        onValue: 'on',
        rule: legacy,
      },
      { identity: 'u-1', attributes: { plan: 'pro' } },
    );
    expect(result.value).toBe('legacy-match');
    expect(result.matched).toBe(true);
    stderrSpy.mockRestore();
  });
});
