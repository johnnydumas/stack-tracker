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

// ---- Day-number helpers ----------------------------------------------
// Loops below step over plain integers ("local day numbers") and only call
// Intl when converting a final candidate back to a timestamp, so even a due
// date years in the past costs microseconds, not seconds.

const dayNumberOf = (p) => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
const weekdayOfDay = (n) => new Date(n * DAY_MS).getUTCDay();
const isWeekendDay = (n) => {
  const wd = weekdayOfDay(n);
  return wd === 0 || wd === 6;
};

function atDay(n, hour, minute, tz) {
  const d = new Date(n * DAY_MS);
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, tz);
}

/** Same wall-clock time, `n` calendar days later (DST-safe). */
export function addLocalDays(ts, n, tz) {
  const p = localParts(ts, tz);
  return atDay(dayNumberOf(p) + n, p.hour, p.minute, tz);
}

/** Same wall-clock time and day-of-month, `n` months later (clamped to month end). */
export function addLocalMonths(ts, n, tz) {
  const p = localParts(ts, tz);
  return monthSlot(p.year, p.month - 1 + n, p.day, p.hour, p.minute, tz);
}

function monthSlot(year, monthIndex, day, hour, minute, tz) {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return zonedTimeToUtc(y, m + 1, Math.min(day, lastDay), hour, minute, tz);
}

export function isWeekend(ts, tz) {
  const wd = localParts(ts, tz).weekday;
  return wd === 0 || wd === 6;
}

/** If `ts` falls on a Saturday/Sunday, moves it to Monday at the same time. */
export function skipWeekend(ts, tz) {
  const p = localParts(ts, tz);
  let n = dayNumberOf(p);
  if (!isWeekendDay(n)) return ts;
  while (isWeekendDay(n)) n += 1;
  return atDay(n, p.hour, p.minute, tz);
}

/** Same wall-clock time, `n` working days (Mon–Fri) later. */
export function addWorkDays(ts, n, tz) {
  const p = localParts(ts, tz);
  let d = dayNumberOf(p);
  let count = 0;
  while (count < n) {
    d += 1;
    if (!isWeekendDay(d)) count += 1;
  }
  return atDay(d, p.hour, p.minute, tz);
}

/** Number of working days that have fully started between two instants (local dates). */
export function workDaysBetween(startTs, endTs, tz) {
  const start = dayNumberOf(localParts(startTs, tz));
  const end = dayNumberOf(localParts(endTs, tz));
  let count = 0;
  for (let d = start + 1; d <= end; d += 1) if (!isWeekendDay(d)) count += 1;
  return count;
}

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

/**
 * Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" as wall-clock time in `tz`.
 * Date-only means 9:00 AM. Years outside 2000–2100 are rejected (null),
 * which catches typos like 0026 or 20266 from date pickers.
 */
export function parseLocalInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h = '09', mi = '00'] = m;
  const year = Number(y);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59) return null;
  return zonedTimeToUtc(year, Number(mo), Number(d), Number(h), Number(mi), tz);
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
 * slot after `after`. The slots are simply every weekday from the day after
 * the due date onward, so we can jump straight to the right day.
 */
export function nextOverdueReminder(dueAt, after, tz) {
  const due = localParts(dueAt, tz);
  const afterDay = dayNumberOf(localParts(after, tz));
  let n = Math.max(dayNumberOf(due) + 1, afterDay - 1);
  for (;;) {
    if (!isWeekendDay(n)) {
      const t = atDay(n, due.hour, due.minute, tz);
      if (t > after) return t;
    }
    n += 1;
  }
}

/** Waiting-column nudge: every 3 working days after `since`, first slot after `after`. */
export const WAITING_NUDGE_WORK_DAYS = 3;
export function nextWaitingNudge(since, after, tz) {
  const s = localParts(since, tz);
  const afterDay = dayNumberOf(localParts(after, tz));
  let n = dayNumberOf(s);
  let count = 0;
  for (;;) {
    n += 1;
    if (isWeekendDay(n)) continue;
    count += 1;
    if (count % WAITING_NUDGE_WORK_DAYS !== 0 || n < afterDay - 1) continue;
    const t = atDay(n, s.hour, s.minute, tz);
    if (t > after) return t;
  }
}

export const RECURRENCE_LABELS = {
  daily: 'Daily',
  weekdays: 'Every weekday',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
};

const DAY_STEPS = { daily: 1, weekly: 7, biweekly: 14 };

/**
 * Next due date for a recurring activity being completed. Steps forward from
 * the current due date until it lands in the future, so a task that was
 * completed late doesn't come back already overdue.
 */
export function nextRecurrenceDue(type, dueAt, now, tz) {
  if (!RECURRENCE_LABELS[type]) return null;
  let base;
  if (dueAt == null) {
    const p = localParts(now, tz);
    base = { ...p, hour: 9, minute: 0 };
  } else {
    base = localParts(dueAt, tz);
  }
  const baseDay = dayNumberOf(base);
  const nowDay = dayNumberOf(localParts(now, tz));

  if (type === 'monthly') {
    const nowP = localParts(now, tz);
    const baseMonth = base.year * 12 + base.month - 1;
    let k = Math.max(1, nowP.year * 12 + nowP.month - 1 - baseMonth - 1);
    for (;;) {
      const t = monthSlot(base.year, base.month - 1 + k, base.day, base.hour, base.minute, tz);
      if (t > now) return t;
      k += 1;
    }
  }

  if (type === 'weekdays') {
    let n = Math.max(baseDay + 1, nowDay - 1);
    for (;;) {
      if (!isWeekendDay(n)) {
        const t = atDay(n, base.hour, base.minute, tz);
        if (t > now) return t;
      }
      n += 1;
    }
  }

  const step = DAY_STEPS[type];
  let k = Math.max(1, Math.floor((nowDay - 1 - baseDay) / step));
  for (;;) {
    const t = atDay(baseDay + k * step, base.hour, base.minute, tz);
    if (t > now) return t;
    k += 1;
  }
}
