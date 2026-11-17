/**
 * Days as the desk reads them: "today", "yesterday", or the weekday and date —
 * in the office's own clock, the browser's, since that is the day the teller
 * lived through.
 */

/** A moment's day, as a key that sorts and compares: "2026-11-17". */
export function dayKey(at: string | Date): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Today's key, and the one a number of days before it. */
export function daysAgo(count: number): string {
  const date = new Date();
  date.setDate(date.getDate() - count);
  return dayKey(date);
}

/** The heading a day goes under. */
export function dayLabel(
  key: string,
  locale: string,
  words: { today: string; yesterday: string },
): string {
  if (key === daysAgo(0)) return words.today;
  if (key === daysAgo(1)) return words.yesterday;
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(locale === 'ar' ? 'ar' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(year !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** A moment's time of day, 24-hour, read left to right. */
export function clockOf(at: string | Date): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
