export function newId() {
  return crypto.randomUUID();
}

export const STATUS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting: 'Waiting for Update',
  completed: 'Completed',
};

/** Completed activities drop off the board into the archive after this long. */
export const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** "Thu, Nov 20, 9:00 AM" in the given zone. */
export function formatLocal(ts, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

/** 1440 -> "1 day", 60 -> "1 hour", 15 -> "15 minutes", 0 -> "now". */
export function formatOffset(minutes) {
  if (minutes === 0) return 'now';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 10080 === 0) return plural(minutes / 10080, 'week');
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/** Thrown for bad user input; the API turns it into a 400. */
export class ValidationError extends Error {}
