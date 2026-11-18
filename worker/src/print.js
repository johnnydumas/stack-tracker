import {
  localParts, zonedTimeToUtc, skipWeekend, addLocalDays, addWorkDays, workDaysBetween, nextRecurrenceDue,
  isWeekend,
} from '../../public/shared/time.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const WORK_DAYS = 5;

/**
 * The five working days a printed sheet covers: starting today (or the next
 * Monday when printed on a weekend). Returns day starts (local midnight) and
 * the end of the last day.
 */
export function printWindow(now, tz) {
  const p = localParts(now, tz);
  const first = skipWeekend(zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz), tz);
  const days = [first];
  while (days.length < WORK_DAYS) days.push(addWorkDays(days[days.length - 1], 1, tz));
  return { days, start: first, end: addLocalDays(days[days.length - 1], 1, tz) };
}

/**
 * Builds the printable sheet (layout B): overdue, due in the window (with
 * repeating activities listed on each day they fall), waiting, in progress,
 * and not-started items with no date. Completed activities are left off.
 */
export function buildPrintSheet({ activities, lastNotes, now, tz, project }) {
  const win = printWindow(now, tz);
  const inProject = (a) => {
    if (!project || project === 'all') return true;
    if (project === 'none') return !a.project_id;
    return a.project_id === project;
  };
  const open = activities.filter((a) => a.status !== 'completed' && inProject(a));
  const note = (a) => lastNotes.get(a.id) || null;
  const row = (a, extra = {}) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    priority: a.priority,
    project_id: a.project_id,
    due_at: a.due_at,
    recurrence: a.recurrence,
    waiting_days: a.status === 'waiting' ? workDaysBetween(a.status_changed_at, now, tz) : null,
    last_note: note(a),
    ...extra,
  });

  const overdue = [];
  const due = [];
  const listed = new Set();

  for (const a of open) {
    if (a.due_at == null) continue;
    if (a.due_at < now) {
      overdue.push(row(a));
      listed.add(a.id);
    } else if (a.due_at < win.end) {
      due.push(row(a));
      listed.add(a.id);
    }
    // Later occurrences of a repeating activity inside the window.
    if (a.recurrence) {
      let t = a.due_at;
      for (let guard = 0; guard < 40; guard += 1) {
        t = nextRecurrenceDue(a.recurrence, t, t, tz);
        if (t == null || t >= win.end) break;
        // Repeat copies that land on a weekend are left off the work sheet.
        if (t >= now && !isWeekend(t, tz)) {
          due.push(row(a, { due_at: t, occurrence: true }));
          listed.add(a.id);
        }
      }
    }
  }

  const byPriority = (x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority];
  overdue.sort((x, y) => x.due_at - y.due_at);
  due.sort((x, y) => x.due_at - y.due_at || byPriority(x, y));

  const waiting = open
    .filter((a) => a.status === 'waiting' && !listed.has(a.id))
    .sort((x, y) => x.status_changed_at - y.status_changed_at)
    .map((a) => row(a));
  const inProgress = open
    .filter((a) => a.status === 'in_progress' && !listed.has(a.id))
    .sort((x, y) => byPriority(x, y) || (x.due_at ?? Infinity) - (y.due_at ?? Infinity))
    .map((a) => row(a));
  const notStarted = open
    .filter((a) => a.status === 'not_started' && a.due_at == null)
    .sort((x, y) => byPriority(x, y) || x.created_at - y.created_at)
    .map((a) => row(a));

  // How many things are due on each of the five days.
  const perDay = win.days.map((dayStart, i) => {
    const dayEnd = i + 1 < win.days.length ? win.days[i + 1] : win.end;
    const nextMidnight = addLocalDays(dayStart, 1, tz);
    const until = Math.min(dayEnd, nextMidnight);
    return {
      day: dayStart,
      count: due.filter((r) => r.due_at >= dayStart && r.due_at < until).length,
    };
  });

  return {
    window: { start: win.start, end: win.end, days: win.days },
    per_day: perDay,
    groups: { overdue, due, waiting, in_progress: inProgress, not_started: notStarted },
  };
}
