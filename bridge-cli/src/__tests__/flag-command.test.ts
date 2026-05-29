/**
 * TBP-192 — Unit tests for the FF 2.0 flag command helpers.
 *
 * Covers:
 *   - coerceValue() — boolean / number / string / json
 *   - buildFlagWritePayload() — happy path + invalid state + invalid valueType
 *   - parseRuleArg() — happy path + invalid JSON + missing otherwiseValue
 *   - parseAttributes() — key=value pairs with JSON coercion
 *   - validateRule() — rejects branch with no conditions; rejects bad rolloutPct
 *   - evaluateLocally() — state=off, state=on, state=on-with-rule (match + otherwise + rollout)
 */

// Mock auth-core (the imported module ships ESM that ts-jest's CommonJS
// transform doesn't handle). The helper functions under test never touch the
// real management client.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
  { virtual: true },
);

import {
  coerceValue,
  buildFlagWritePayload,
  parseRuleArg,
  parseAttributes,
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
          conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
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
  it('parses a valid rule', () => {
    const rule = parseRuleArg(
      JSON.stringify({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
            returnValue: true,
          },
        ],
        otherwiseValue: false,
        rolloutPct: 50,
      }),
    );
    expect(rule.branches).toHaveLength(1);
    expect(rule.rolloutPct).toBe(50);
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
              conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
              returnValue: true,
            },
          ],
        }),
      ),
    ).toThrow(/otherwiseValue/);
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

describe('validateRule', () => {
  it('returns no errors for a valid rule', () => {
    expect(
      validateRule({
        branches: [
          {
            conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
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
          conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 150,
    });
    expect(errs.some((e) => /rolloutPct/.test(e.message))).toBe(true);
  });
});

describe('evaluateLocally', () => {
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

  it('matches a branch on equals', () => {
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
              conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
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
              conditions: [{ attribute: 'plan', operator: 'equals', value: 'enterprise' }],
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
              conditions: [{ attribute: 'plan', operator: 'equals', value: 'pro' }],
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
});
