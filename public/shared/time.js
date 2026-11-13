// Time-zone aware date math, shared by the Worker and the browser.
// Everything works on unix-ms timestamps plus an IANA zone name
// (e.g. "America/Chicago"), so DST transitions are handled by Intl.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `ts` in `tz`. weekday: 0 = Sunday … 6 = Saturday. */
export function localParts(ts, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: WEEKDAYS[o.weekday],
  };
}

function offsetAt(ts, tz) {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a unix-ms timestamp. */
export function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** Same wall-clock time, `n` calendar days later (DST-safe). */
export function addLocalDays(ts, n, tz) {
  const p = localParts(ts, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.hour, p.minute, tz);
}

/** Same wall-clock time and day-of-month, `n` months later (clamped to month end). */
export function addLocalMonths(ts, n, tz) {
  const p = localParts(ts, tz);
  const target = new Date(Date.UTC(p.year, p.month - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return zonedTimeToUtc(
    target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(p.day, lastDay), p.hour, p.minute, tz
  );
}

export function isWeekend(ts, tz) {
  const wd = localParts(ts, tz).weekday;
  return wd === 0 || wd === 6;
}

/** If `ts` falls on a Saturday/Sunday, moves it to Monday at the same time. */
export function skipWeekend(ts, tz) {
  let t = ts;
  while (isWeekend(t, tz)) t = addLocalDays(t, 1, tz);
  return t;
}

/** Same wall-clock time, `n` working days (Mon–Fri) later. */
export function addWorkDays(ts, n, tz) {
  let t = ts;
  let count = 0;
  while (count < n) {
    t = addLocalDays(t, 1, tz);
    if (!isWeekend(t, tz)) count += 1;
  }
  return t;
}

/** Number of working days that have fully started between two instants (local dates). */
export function workDaysBetween(startTs, endTs, tz) {
  const s = localParts(startTs, tz);
  const e = localParts(endTs, tz);
  const start = Date.UTC(s.year, s.month - 1, s.day);
  const end = Date.UTC(e.year, e.month - 1, e.day);
  let count = 0;
  for (let x = start + DAY_MS; x <= end; x += DAY_MS) {
    const wd = new Date(x).getUTCDay();
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

/** Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" as wall-clock time in `tz`. Date-only means 9:00 AM. */
export function parseLocalInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h = '09', mi = '00'] = m;
  return zonedTimeToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), tz);
}

/** Inverse of parseLocalInput: { date: "YYYY-MM-DD", time: "HH:mm" }. */
export function toLocalInput(ts, tz) {
  const p = localParts(ts, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/**
 * Overdue reminder schedule: first one 24h after the due time, then every
 * 24h, never on a weekend (pushed to Monday, same time). Returns the first
 * slot after `after`.
 */
export function nextOverdueReminder(dueAt, after, tz) {
  let t = skipWeekend(addLocalDays(dueAt, 1, tz), tz);
  while (t <= after) t = skipWeekend(addLocalDays(t, 1, tz), tz);
  return t;
}

/** Waiting-column nudge: every 3 working days after `since`, first slot after `after`. */
export const WAITING_NUDGE_WORK_DAYS = 3;
export function nextWaitingNudge(since, after, tz) {
  let t = addWorkDays(since, WAITING_NUDGE_WORK_DAYS, tz);
  while (t <= after) t = addWorkDays(t, WAITING_NUDGE_WORK_DAYS, tz);
  return t;
}

export const RECURRENCE_LABELS = {
  daily: 'Daily',
  weekdays: 'Every weekday',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
};

function stepRecurrence(type, ts, tz) {
  switch (type) {
    case 'daily': return addLocalDays(ts, 1, tz);
    case 'weekdays': return skipWeekend(addLocalDays(ts, 1, tz), tz);
    case 'weekly': return addLocalDays(ts, 7, tz);
    case 'biweekly': return addLocalDays(ts, 14, tz);
    case 'monthly': return addLocalMonths(ts, 1, tz);
    default: return null;
  }
}

/**
 * Next due date for a recurring activity being completed. Steps forward from
 * the current due date until it lands in the future, so a task that was
 * completed late doesn't come back already overdue.
 */
export function nextRecurrenceDue(type, dueAt, now, tz) {
  if (!RECURRENCE_LABELS[type]) return null;
  let base = dueAt;
  if (base == null) {
    const p = localParts(now, tz);
    base = zonedTimeToUtc(p.year, p.month, p.day, 9, 0, tz);
  }
  let t = stepRecurrence(type, base, tz);
  let guard = 0;
  while (t <= now && guard < 2000) {
    t = stepRecurrence(type, t, tz);
    guard += 1;
  }
  return t;
}
