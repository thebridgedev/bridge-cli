/**
 * TBP-617 — unit tests for the `plan create` / `plan price rm` price guards.
 *
 * The API rejects an explicitly empty price list ("A plan needs at least one
 * price…", HTTP 400), so the CLI must never send one: `plan create` builds its
 * first price from flags, and `plan price rm` refuses to remove the last price.
 */

// plan.command.ts imports config/output at module load; stub them so importing
// the pure helpers has no side effects (no real management client).
jest.mock('../config.js', () => ({ getManagementClient: jest.fn() }));
jest.mock('../output.js', () => ({ outputSuccess: jest.fn(), outputError: jest.fn() }));

import {
  buildCreatePlanPrices,
  removePrice,
  type PlanPriceInput,
} from '../commands/plan.command.js';

describe('buildCreatePlanPrices (TBP-617)', () => {
  it('builds a single-price payload from amount + interval (currency defaults to USD)', () => {
    expect(buildCreatePlanPrices({ amount: 29, interval: 'month' })).toEqual([
      { amount: 29, currency: 'USD', recurrenceInterval: 'month' },
    ]);
  });

  it('honours an explicit currency and upper-cases it', () => {
    expect(buildCreatePlanPrices({ amount: 290, interval: 'year', currency: 'eur' })).toEqual([
      { amount: 290, currency: 'EUR', recurrenceInterval: 'year' },
    ]);
  });

  it('accepts a zero-amount price for a free or contact-sales tier', () => {
    expect(buildCreatePlanPrices({ amount: 0, interval: 'month' })).toEqual([
      { amount: 0, currency: 'USD', recurrenceInterval: 'month' },
    ]);
  });

  it('never produces an empty price list — the shape the API rejects', () => {
    expect(buildCreatePlanPrices({ amount: 0, interval: 'month' })).toHaveLength(1);
  });

  it('rejects a create with no price flags, naming the flags to pass', () => {
    expect(() => buildCreatePlanPrices({})).toThrow(/A plan needs at least one price/);
    expect(() => buildCreatePlanPrices({})).toThrow(/--amount and --interval/);
    expect(() => buildCreatePlanPrices({})).toThrow(/--amount 0 for a free/);
  });

  it('rejects an amount with no interval', () => {
    expect(() => buildCreatePlanPrices({ amount: 29 })).toThrow(/--interval is required/);
  });

  it('rejects an interval with no amount', () => {
    expect(() => buildCreatePlanPrices({ interval: 'month' })).toThrow(/--amount must be a number/);
  });

  it('rejects a negative amount and an unknown interval', () => {
    expect(() => buildCreatePlanPrices({ amount: -1, interval: 'month' })).toThrow(
      /--amount must be a number >= 0/,
    );
    expect(() => buildCreatePlanPrices({ amount: 1, interval: 'fortnight' })).toThrow(
      /--interval is required and must be one of/,
    );
  });
});

describe('removePrice (TBP-617)', () => {
  const monthly: PlanPriceInput = { amount: 29, currency: 'USD', recurrenceInterval: 'month' };
  const yearly: PlanPriceInput = { amount: 290, currency: 'USD', recurrenceInterval: 'year' };

  it('removes a price when others remain', () => {
    expect(removePrice([monthly, yearly], { currency: 'usd', interval: 'year' }, 'pro')).toEqual([
      monthly,
    ]);
  });

  it('refuses to remove the last price rather than emptying the list', () => {
    expect(() => removePrice([monthly], { currency: 'USD', interval: 'month' }, 'pro')).toThrow(
      /Cannot remove the only price on plan "pro": a plan needs at least one price/,
    );
  });

  it('points at the fix when refusing the last price', () => {
    expect(() => removePrice([monthly], { currency: 'USD', interval: 'month' }, 'pro')).toThrow(
      /bridge plan price set pro --amount <n> --interval <interval>/,
    );
  });

  it('reports a price that is not on the plan', () => {
    expect(() => removePrice([monthly], { currency: 'EUR', interval: 'month' }, 'pro')).toThrow(
      /No EUR month price on plan "pro"\./,
    );
  });

  it('matches on currency AND interval, not either alone', () => {
    const eurMonthly: PlanPriceInput = {
      amount: 25,
      currency: 'EUR',
      recurrenceInterval: 'month',
    };
    expect(
      removePrice([monthly, eurMonthly], { currency: 'EUR', interval: 'month' }, 'pro'),
    ).toEqual([monthly]);
  });
});
