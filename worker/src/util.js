export function newId() {
  return crypto.randomUUID();
}

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sort comparator used everywhere a task list is returned.
 * Overdue tasks float to the top, then by due date, then by priority.
 */
export function compareTasks(a, b, now) {
  const aOverdue = a.due_at != null && a.due_at < now;
  const bOverdue = b.due_at != null && b.due_at < now;
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

  const aDue = a.due_at ?? Infinity;
  const bDue = b.due_at ?? Infinity;
  if (aDue !== bDue) return aDue - bDue;

  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

/**
 * The "Today" view: overdue tasks, tasks due within 24h, and high-priority
 * tasks with no due date, capped so it never turns into the full list.
 * If nothing qualifies, falls back to the top of the full sorted list so
 * there's always something to point at.
 */
export function pickTodayTasks(openTasks, now, limit = 7) {
  const sorted = [...openTasks].sort((a, b) => compareTasks(a, b, now));
  const qualifies = (t) =>
    (t.due_at != null && t.due_at < now + DAY_MS) ||
    (t.due_at == null && t.priority === 'high');

  const primary = sorted.filter(qualifies).slice(0, limit);
  if (primary.length > 0) return primary;
  return sorted.slice(0, Math.min(3, sorted.length));
}

export function pickStaleTasks(openTasks, now, staleAfterMs = 7 * DAY_MS) {
  return openTasks
    .filter((t) => now - t.last_touched_at >= staleAfterMs)
    .sort((a, b) => a.last_touched_at - b.last_touched_at);
}

/**
 * Given a recurrence rule and the timestamp a task was completed from,
 * compute the next due_at. Returns null if the rule is missing/invalid.
 * Rule shapes: {type:'daily'} | {type:'weekly'} | {type:'every_n_days', n}
 */
export function nextDueAt(recurrence, fromTs) {
  if (!recurrence) return null;
  let rule;
  try {
    rule = typeof recurrence === 'string' ? JSON.parse(recurrence) : recurrence;
  } catch {
    return null;
  }
  const base = new Date(fromTs);
  switch (rule?.type) {
    case 'daily':
      base.setUTCDate(base.getUTCDate() + 1);
      return base.getTime();
    case 'weekly':
      base.setUTCDate(base.getUTCDate() + 7);
      return base.getTime();
    case 'every_n_days': {
      const n = Number.isFinite(rule.n) && rule.n > 0 ? rule.n : 1;
      base.setUTCDate(base.getUTCDate() + n);
      return base.getTime();
    }
    default:
      return null;
  }
}
