/**
 * Pure formatting helpers, safe to import from both server and client code.
 *
 * IMPORTANT: `formatDateTimeUtc` is the only date formatter used during server
 * rendering. Locale- and timezone-sensitive formatting happens exclusively in
 * the `<LocalTime>` client component after mount, because a server rendering in
 * UTC and a browser rendering in UTC+8 would otherwise produce a React
 * hydration mismatch on every date on the page.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function to12Hour(hours: number): { hour: number; suffix: 'AM' | 'PM' } {
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return { hour, suffix };
}

/**
 * Deterministic absolute timestamp, always in UTC and always labelled as such.
 * Identical on the server and in every browser, so it is hydration-safe.
 */
export function formatDateTimeUtc(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '--';

  const { hour, suffix } = to12Hour(date.getUTCHours());

  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${pad(
    date.getUTCMinutes(),
  )} ${suffix} UTC`;
}

/** Date only, in UTC. */
export function formatDateUtc(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '--';

  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Locale-aware formatting. Client-side only. */
export function formatDateTimeLocal(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '--';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** `2026-09-17T20:00` for a `datetime-local` input, in the browser timezone. */
export function toDateTimeLocalInput(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact duration, e.g. `2d 4h`, `15m 30s`, `Ended`. */
export function formatCountdown(millisecondsRemaining: number): string {
  if (millisecondsRemaining <= 0) return 'Ended';

  const days = Math.floor(millisecondsRemaining / DAY);
  const hours = Math.floor((millisecondsRemaining % DAY) / HOUR);
  const minutes = Math.floor((millisecondsRemaining % HOUR) / MINUTE);
  const seconds = Math.floor((millisecondsRemaining % MINUTE) / SECOND);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `3 minutes ago`, `in 2 days`. */
export function formatRelative(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '--';

  const delta = date.getTime() - now.getTime();
  const magnitude = Math.abs(delta);

  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    magnitude < MINUTE
      ? [Math.round(delta / SECOND), 'second']
      : magnitude < HOUR
        ? [Math.round(delta / MINUTE), 'minute']
        : magnitude < DAY
          ? [Math.round(delta / HOUR), 'hour']
          : [Math.round(delta / DAY), 'day'];

  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(amount, unit);
}

/** `44.8%`. Guards against a zero denominator. */
export function formatPercent(part: number, total: number, fractionDigits = 1): string {
  if (total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(fractionDigits)}%`;
}

/** Raw percentage number, for bar widths. */
export function percentValue(part: number, total: number): number {
  if (total <= 0) return 0;
  return (part / total) * 100;
}

/** `1,234` */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** `183 votes` / `1 vote` */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
