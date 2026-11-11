/** Small date helpers. Formatting is manual so it is identical on iOS, Android and web. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2027-01-14" or a full ISO timestamp -> "14 Jan 2027". Dates without a time are read as UTC. */
export function formatDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const month = MONTHS[Number(dateOnly[2]) - 1];
    return month ? `${Number(dateOnly[3])} ${month} ${dateOnly[1]}` : value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function localDayNumber(date: Date): number {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / DAY_MS);
}

/** "Today", "Yesterday" or "14 Jan 2027", in the device's time zone. */
export function formatRelativeDay(value: string, nowMs: number = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const difference = localDayNumber(new Date(nowMs)) - localDayNumber(date);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return formatDate(value);
}

/**
 * The date `months` after `nowMs` as "YYYY-MM-DD" (UTC), moved forward off a
 * weekend. Bank holidays are NOT handled; the provider decides valid dates.
 */
export function settlementDateAfterMonths(months: number, nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay)));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

/** "14:05" in the device's time zone, for "as of" labels. */
export function formatTimeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}
