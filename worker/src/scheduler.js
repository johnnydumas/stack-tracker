import { DurableObject } from 'cloudflare:workers';
import {
  getSettings, nextScheduledEvent, dueOverdueReminders, setNextOverdue, dueWaitingNudges,
  setNextWaiting, duePreReminders, markReminderFired, insertNotification, pruneNotifications,
} from './db.js';
import { sendPushToAll } from './push.js';
import { formatLocal, formatOffset } from './util.js';
import { nextOverdueReminder, nextWaitingNudge, workDaysBetween } from '../../public/shared/time.js';
import { sqlStore, createSchema, migrateFromD1 } from './store.js';
import { app } from './api.js';

// A pre-due reminder whose time passed more than this long ago (e.g. the
// alarm ran late) is skipped rather than sent stale.
const LATE_GRACE_MS = 60 * 60 * 1000;

/**
 * The single Durable Object that holds all of the app's data and runs its
 * reminders.
 *
 * - Data lives in this object's own SQLite storage (see store.js), on the
 *   same machine as the code, so queries don't cross the network.
 * - Every /api request is forwarded here by the Worker and handled by the
 *   Hono app in api.js.
 * - One alarm is kept set for the earliest upcoming reminder across every
 *   activity; it is re-armed after anything that changes the schedule.
 */
export class ReminderScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = {
      ...env,
      DB: sqlStore(ctx.storage),
      LEGACY_D1: env.DB,
      RESCHEDULE: () => this.reschedule(),
    };
    ctx.blockConcurrencyWhile(async () => {
      createSchema(ctx.storage.sql);
      await migrateFromD1(ctx.storage, env.DB).catch((err) => console.error('D1 migration failed', err));
      await this.reschedule();
    });
  }

  async fetch(request) {
    return app.fetch(request, this.store, {
      waitUntil: (promise) => {
        this.ctx.waitUntil(promise);
      },
      passThroughOnException() {},
    });
  }

  async reschedule() {
    const next = await nextScheduledEvent(this.store);
    if (next == null) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const at = Math.max(next, Date.now() + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current !== at) await this.ctx.storage.setAlarm(at);
    return at;
  }

  async alarm() {
    await runDueReminders(this.store, Date.now());
    await this.reschedule();
  }
}

export async function runDueReminders(env, now) {
  const { timezone: tz } = await getSettings(env);

  // 1. Pre-due reminders the user set on each activity.
  for (const row of await duePreReminders(env, now)) {
    const fireAt = row.due_at - row.offset_minutes * 60000;
    await markReminderFired(env, row.reminder_id, now);
    if (now - fireAt > LATE_GRACE_MS) continue;
    await notify(env, {
      activity_id: row.id,
      kind: 'reminder',
      title: row.offset_minutes === 0 ? 'Due now' : `Due in ${formatOffset(row.offset_minutes)}`,
      body: `"${row.title}" is due ${formatLocal(row.due_at, tz)}.`,
    });
  }

  // 2. Overdue: once per 24h, weekdays only (the schedule itself skips weekends).
  for (const a of await dueOverdueReminders(env, now)) {
    const days = Math.max(1, Math.round((now - a.due_at) / 86400000));
    await notify(env, {
      activity_id: a.id,
      kind: 'overdue',
      title: 'Overdue',
      body: `"${a.title}" was due ${formatLocal(a.due_at, tz)} (${days} day${days === 1 ? '' : 's'} ago).`,
    });
    await setNextOverdue(env, a.id, nextOverdueReminder(a.due_at, now, tz));
  }

  // 3. Waiting for Update for 3+ work days.
  for (const a of await dueWaitingNudges(env, now)) {
    const days = workDaysBetween(a.status_changed_at, now, tz);
    await notify(env, {
      activity_id: a.id,
      kind: 'waiting',
      title: 'Still waiting — follow up?',
      body: `"${a.title}" has been waiting for an update for ${days} work day${days === 1 ? '' : 's'}.`,
    });
    await setNextWaiting(env, a.id, nextWaitingNudge(a.status_changed_at, now, tz));
  }

  await pruneNotifications(env, now);
}

async function notify(env, n) {
  const row = await insertNotification(env, n);
  await sendPushToAll(env, {
    title: n.title,
    body: n.body,
    activityId: n.activity_id,
    tag: `${n.kind}-${n.activity_id}`,
    notificationId: row.id,
  });
}
