/**
 * TBP-113 — relative time formatter (used by `bridge auth status`).
 */
import { formatRelativeTime } from '../auth/relative-time';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('returns "just now" for sub-second deltas', () => {
    expect(formatRelativeTime(0)).toBe('just now');
    expect(formatRelativeTime(500)).toBe('just now');
    expect(formatRelativeTime(-500)).toBe('just now');
  });

  it('formats future deltas with "in"', () => {
    expect(formatRelativeTime(9 * DAY)).toBe('in 9 days');
    expect(formatRelativeTime(3 * HOUR)).toBe('in 3 hours');
    expect(formatRelativeTime(45 * MINUTE)).toBe('in 45 minutes');
  });

  it('formats past deltas with "ago"', () => {
    expect(formatRelativeTime(-2 * DAY)).toBe('2 days ago');
    expect(formatRelativeTime(-1 * HOUR)).toBe('1 hour ago');
  });

  it('singularizes 1-unit deltas', () => {
    expect(formatRelativeTime(1 * DAY)).toBe('in 1 day');
    expect(formatRelativeTime(-1 * DAY)).toBe('1 day ago');
  });
});
