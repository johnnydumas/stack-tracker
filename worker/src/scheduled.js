import { listOpenTasks, markReminded } from './db.js';
import { pickStaleTasks } from './util.js';
import { sendPushToAll } from './push.js';

const DUE_SOON_WINDOW_MS = 15 * 60 * 1000;      // heads-up when due within 15 min
const ESCALATION_INTERVAL_MS = 3 * 60 * 60 * 1000; // re-nag every 3h while overdue

export async function handleScheduled(event, env) {
  const now = Date.now();
  switch (event.cron) {
    case '*/15 * * * *':
      await sendReminders(env, now);
      break;
    case '0 8 * * *':
      await sendMorningPrompt(env, now);
      break;
    case '0 9 * * 1':
      await sendStaleDigest(env, now);
      break;
    default:
      console.warn(`unrecognized cron trigger: ${event.cron}`);
  }
}

async function sendReminders(env, now) {
  const open = await listOpenTasks(env);

  for (const task of open) {
    if (task.due_at == null) continue;

    const isOverdue = task.due_at < now;
    const isDueSoon = !isOverdue && task.due_at - now <= DUE_SOON_WINDOW_MS;
    if (!isOverdue && !isDueSoon) continue;

    const dueForReminder =
      task.reminded_at == null ||
      (isOverdue && now - task.reminded_at >= ESCALATION_INTERVAL_MS);
    if (!dueForReminder) continue;

    const title = isOverdue ? 'Overdue' : 'Coming up';
    const body = isOverdue
      ? `"${task.title}" was due ${formatRelative(now - task.due_at)} ago.`
      : `"${task.title}" is due in ${Math.round((task.due_at - now) / 60000)} min.`;

    await sendPushToAll(env, { title, body, taskId: task.id, tag: `task-${task.id}` });
    await markReminded(env, task.id, isOverdue ? task.escalation_count + 1 : task.escalation_count);
  }
}

async function sendMorningPrompt(env, now) {
  const open = await listOpenTasks(env);
  const dueOrOverdue = open.filter((t) => t.due_at != null && t.due_at < now + 24 * 60 * 60 * 1000).length;
  const body =
    dueOrOverdue > 0
      ? `${dueOrOverdue} task${dueOrOverdue === 1 ? '' : 's'} due today. Pick your top 3 and start there.`
      : `Nothing due today. Good time to pick 3 priorities anyway.`;
  await sendPushToAll(env, { title: 'Plan your day', body, tag: 'morning-prompt' });
}

async function sendStaleDigest(env, now) {
  const open = await listOpenTasks(env);
  const stale = pickStaleTasks(open, now);
  if (stale.length === 0) return;
  const body = `${stale.length} task${stale.length === 1 ? ' has' : 's have'} been sitting untouched for a week+. Clear, defer, or drop them.`;
  await sendPushToAll(env, { title: 'Weekly review', body, tag: 'stale-digest' });
}

function formatRelative(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60000))}m`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
