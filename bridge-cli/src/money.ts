import type { Price, UsagePrice } from './api/billing.js';
import { CliError } from './core/errors.js';

/**
 * Prices are written the way people say them ("19.99 EUR/month") and sent
 * the way Bridge keeps them: whole minor units (1999), and per-unit usage
 * prices as minor units in text ("0.25" for 0.0025 EUR a unit).
 */
export const INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];

/** How many minor units a currency has: 2 for EUR, 0 for JPY, 3 for KWD. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new CliError('invalid', `${currency} is not a currency code, such as EUR or USD.`);
  }
}

function currencyOf(text: string): string {
  const code = text.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new CliError('invalid', `${text} is not a three-letter currency code, such as EUR.`);
  currencyDigits(code);
  return code;
}

/** "19.99" in EUR → "1999", "0.0025" in EUR → "0.25": the decimal point moved by the currency's digits, with no rounding. */
function shift(amount: string, digits: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new CliError('invalid', `${amount} is not an amount, such as 19.99.`);
  const [whole, fraction = ''] = amount.split('.') as [string, string?];
  const padded = fraction.padEnd(digits, '0');
  const head = (whole + padded.slice(0, digits)).replace(/^0+(?=\d)/, '');
  const tail = padded.slice(digits).replace(/0+$/, '');
  return tail === '' ? head : `${head}.${tail}`;
}

/** An amount in major units as whole minor units; refused when it has more decimals than the currency. */
export function toMinor(amount: string, currency: string): number {
  const shifted = shift(amount, currencyDigits(currency));
  if (shifted.includes('.')) throw new CliError('invalid', `${amount} ${currency} has more decimals than ${currency} has.`);
  return Number(shifted);
}

/** "<CURRENCY>/<interval>" or "<CURRENCY>" for a one-time price. */
export function parseCurrencyInterval(text: string): { currency: string; interval: Interval | null } {
  const [code, every] = text.split('/') as [string, string?];
  const interval = every === undefined ? null : every.toLowerCase();
  if (interval !== null && !(INTERVALS as readonly string[]).includes(interval)) {
    throw new CliError('invalid', `${every} is not an interval: ${INTERVALS.join(', ')}.`);
  }
  return { currency: currencyOf(code), interval: interval as Interval | null };
}

/** "19.99 EUR/month", "190 EUR/year", or "49 EUR" for a one-time price. */
export function parsePrice(text: string): Price {
  const match = /^\s*(\S+)\s+(\S+)\s*$/.exec(text);
  if (!match) throw new CliError('invalid', `A price is "<amount> <CURRENCY>/<interval>", such as "19.99 EUR/month": ${text}`);
  const { currency, interval } = parseCurrencyInterval(match[2] as string);
  return { currency, interval, amount: toMinor(match[1] as string, currency) };
}

/**
 * A per-unit usage price on one of the plan's prices:
 * "<metric> <amount per unit> <CURRENCY>[/<interval>] [included <n>]",
 * such as "api.calls 0.002 EUR/month included 10000".
 */
export function parseUsagePrice(text: string): { usage: UsagePrice; currency: string; interval: Interval | null | undefined } {
  const words = text.trim().split(/\s+/);
  const [metric, amount, at, word, count] = words as [string?, string?, string?, string?, string?];
  if (metric === undefined || amount === undefined || at === undefined || words.length > 5 || (word !== undefined && (word !== 'included' || count === undefined))) {
    throw new CliError('invalid', `A usage price is "<metric> <amount per unit> <CURRENCY>/<interval> [included <n>]", such as "api.calls 0.002 EUR/month included 10000": ${text}`);
  }
  const hasInterval = at.includes('/');
  const { currency, interval } = parseCurrencyInterval(at);
  let included: number | undefined;
  if (count !== undefined) {
    included = Number(count);
    if (!Number.isSafeInteger(included) || included < 0) throw new CliError('invalid', `included is a whole number: ${count}`);
  }
  const unitAmount = shift(amount, currencyDigits(currency));
  return { usage: { metric, unitAmount, ...(included === undefined ? {} : { included }) }, currency, interval: hasInterval ? interval : undefined };
}

/** Puts usage prices on the prices they name: by currency, and by interval when one is named. */
export function attachUsage(prices: Price[], usages: ReturnType<typeof parseUsagePrice>[]): Price[] {
  const out = prices.map((price) => ({ ...price, ...(price.usage === undefined ? {} : { usage: [...price.usage] }) }));
  for (const { usage, currency, interval } of usages) {
    const targets = out.filter((price) => price.currency === currency && (interval === undefined || price.interval === interval) && price.interval !== null);
    if (targets.length === 0) {
      throw new CliError('invalid', `The plan has no recurring ${currency}${interval ? `/${interval}` : ''} price for the usage price on ${usage.metric}.`);
    }
    for (const price of targets) price.usage = [...(price.usage ?? []).filter((each) => each.metric !== usage.metric), usage];
  }
  return out;
}

/** "analytics" or "analytics=Advanced analytics". */
export function parseFeature(text: string): { key: string; name?: string } {
  const [key, ...rest] = text.split('=');
  if (!key) throw new CliError('invalid', `A feature is "<key>" or "<key>=<name>": ${text}`);
  return rest.length === 0 ? { key } : { key, name: rest.join('=') };
}

/** "api.calls=10000" or "seats=unlimited". */
export function parseLimit(text: string): { metric: string; limit: number | null } {
  const [metric, value] = text.split('=') as [string, string?];
  if (!metric || value === undefined) throw new CliError('invalid', `A limit is "<metric>=<n>" or "<metric>=unlimited": ${text}`);
  if (value === 'unlimited') return { metric, limit: null };
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new CliError('invalid', `A limit is a whole number or "unlimited": ${text}`);
  return { metric, limit };
}
