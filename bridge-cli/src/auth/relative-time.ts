/**
 * Tiny human-readable relative time formatter — avoids pulling in dayjs/date-fns.
 *
 * Examples:
 *   formatRelativeTime(+9 days)  → "in 9 days"
 *   formatRelativeTime(+3 hours) → "in 3 hours"
 *   formatRelativeTime(0)        → "just now"
 *   formatRelativeTime(-2 days)  → "2 days ago"
 */
const UNITS: Array<{ name: string; ms: number }> = [
  { name: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { name: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { name: 'day', ms: 24 * 60 * 60 * 1000 },
  { name: 'hour', ms: 60 * 60 * 1000 },
  { name: 'minute', ms: 60 * 1000 },
  { name: 'second', ms: 1000 },
];

export function formatRelativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return 'just now';

  const unit = UNITS.find((u) => abs >= u.ms) ?? UNITS[UNITS.length - 1];
  const value = Math.round(abs / unit.ms);
  const noun = `${unit.name}${value === 1 ? '' : 's'}`;

  return deltaMs >= 0 ? `in ${value} ${noun}` : `${value} ${noun} ago`;
}
