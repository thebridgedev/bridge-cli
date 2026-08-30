/**
 * TBP-275 — unit tests for the `plan quota` metered-pricing helpers
 * (validateQuotaEntry, upsertQuota).
 */

// plan.command.ts imports config/output at module load; stub them so importing
// the pure helpers has no side effects (no real management client).
jest.mock('../config.js', () => ({ getManagementClient: jest.fn() }));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputError: jest.fn() }));

import { validateQuotaEntry, upsertQuota, type Quota } from '../commands/plan.command.js';

describe('validateQuotaEntry (TBP-275)', () => {
  it('accepts a hard quota with no pricing', () => {
    expect(validateQuotaEntry({ metric: 'm', limit: 100, policy: 'hard' })).toEqual({
      metric: 'm',
      limit: 100,
      policy: 'hard',
    });
  });

  it('rejects a hard quota that carries a price', () => {
    expect(() =>
      validateQuotaEntry({ metric: 'm', limit: 100, policy: 'hard', priceAmount: 1 }),
    ).toThrow(/only valid with --policy metered/);
  });

  it('rejects a metered quota with no price amount', () => {
    expect(() =>
      validateQuotaEntry({ metric: 'm', limit: 100, policy: 'metered', currency: 'USD' }),
    ).toThrow(/price-amount must be a number > 0/);
  });

  it('rejects a metered quota with price amount <= 0', () => {
    expect(() =>
      validateQuotaEntry({ metric: 'm', limit: 100, policy: 'metered', priceAmount: 0, currency: 'USD' }),
    ).toThrow(/price-amount must be a number > 0/);
  });

  it('rejects a metered quota with no resolvable currency', () => {
    expect(() =>
      validateQuotaEntry({ metric: 'm', limit: 100, policy: 'metered', priceAmount: 2 }),
    ).toThrow(/currency is required/);
  });

  it('accepts a metered quota with allotment + overage price (currency upper-cased)', () => {
    expect(
      validateQuotaEntry({ metric: 'm', limit: 1000, policy: 'metered', priceAmount: 0.002, currency: 'usd' }),
    ).toEqual({ metric: 'm', limit: 1000, policy: 'metered', pricing: { amount: 0.002, currency: 'USD' } });
  });

  it('accepts pure per-unit metered (limit 0)', () => {
    expect(
      validateQuotaEntry({ metric: 'api', limit: 0, policy: 'metered', priceAmount: 0.01, currency: 'EUR' }),
    ).toEqual({ metric: 'api', limit: 0, policy: 'metered', pricing: { amount: 0.01, currency: 'EUR' } });
  });

  it('rejects a negative or non-integer limit', () => {
    expect(() => validateQuotaEntry({ metric: 'm', limit: -1, policy: 'hard' })).toThrow(/integer >= 0/);
    expect(() => validateQuotaEntry({ metric: 'm', limit: 1.5, policy: 'hard' })).toThrow(/integer >= 0/);
  });

  it('rejects a missing metric', () => {
    expect(() => validateQuotaEntry({ metric: '', limit: 1, policy: 'hard' })).toThrow(/metric is required/);
  });
});

describe('upsertQuota', () => {
  it('replaces an existing quota by metric, preserving pricing', () => {
    const existing: Quota[] = [{ metric: 'a', limit: 10, policy: 'hard' }];
    const next: Quota = { metric: 'a', limit: 0, policy: 'metered', pricing: { amount: 1, currency: 'USD' } };
    expect(upsertQuota(existing, next)).toEqual([next]);
  });

  it('appends a new quota when the metric is new', () => {
    const existing: Quota[] = [{ metric: 'a', limit: 10, policy: 'hard' }];
    const next: Quota = { metric: 'b', limit: 5, policy: 'hard' };
    expect(upsertQuota(existing, next)).toEqual([...existing, next]);
  });
});
