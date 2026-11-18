import { Hono } from 'hono';
import {
  getSettings, setSetting, isValidTimezone,
  createProject, updateProject, deleteProject,
  loadBoardData, listArchived, searchActivities, getActivityDetail,
  createActivity, updateActivity, deleteActivity, restoreActivity,
  addNote, editNote, deleteNote, setReminders,
  listNotifications, unreadCount, markNotificationRead, markAllNotificationsRead,
  saveSubscription, removeSubscription, replanAllSchedules, loadPrintData, listProjects,
} from './db.js';
import { sendPushToAll } from './push.js';
import { ValidationError } from './util.js';
import { buildPrintSheet } from './print.js';

// The HTTP API. It runs inside the Durable Object (see scheduler.js), where
// env.DB is the object's local SQLite storage and env.RESCHEDULE re-arms the
// reminder alarm.
export const app = new Hono();

// API data must never be cached by the browser, a proxy, or a Cloudflare
// cache rule — otherwise a refresh can show an old copy of the board.
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// Log slow requests with a breakdown of time spent waiting on the database,
// so `wrangler tail` / Workers Logs show exactly where time goes.
app.use('/api/*', async (c, next) => {
  const started = Date.now();
  const timing = { dbMs: 0, calls: 0, slowestMs: 0, slowestSql: '' };
  c.env = { ...c.env, DB: instrumentDb(c.env.DB, timing) };
  await next();
  const ms = Date.now() - started;
  c.header('Server-Timing', `db;dur=${timing.dbMs}, total;dur=${ms}`);
  if (ms > 500) {
    console.warn(
      `slow request: ${c.req.method} ${c.req.path} took ${ms}ms — database: ${timing.calls} call(s), ` +
      `${timing.dbMs}ms total, slowest ${timing.slowestMs}ms (${timing.slowestSql}); ` +
      `other: ${ms - timing.dbMs}ms`
    );
  }
});

/** Wraps a D1 binding so every call's wall time is added to `timing`. */
function instrumentDb(db, timing) {
  const track = async (label, fn) => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      const d = Date.now() - t;
      timing.dbMs += d;
      timing.calls += 1;
      if (d >= timing.slowestMs) {
        timing.slowestMs = d;
        timing.slowestSql = label.replace(/\s+/g, ' ').trim().slice(0, 60);
      }
    }
  };
  const wrapStmt = (stmt, sql) => ({
    _stmt: stmt,
    _sql: sql.replace(/\s+/g, ' ').trim().slice(0, 25),
    bind: (...args) => wrapStmt(stmt.bind(...args), sql),
    first: (...a) => track(sql, () => stmt.first(...a)),
    all: () => track(sql, () => stmt.all()),
    run: () => track(sql, () => stmt.run()),
    raw: (...a) => track(sql, () => stmt.raw(...a)),
  });
  return {
    prepare: (sql) => wrapStmt(db.prepare(sql), sql),
    batch: (stmts) => track(`batch of ${stmts.length}: ${stmts.map((x) => x._sql || '').join('; ')}`,
      () => db.batch(stmts.map((x) => x._stmt || x))),
    exec: (sql) => track(sql, () => db.exec(sql)),
  };
}

// ---- Auth: every /api/* route except the passcode check needs `Authorization: Bearer <passcode>` ----

function expectedPasscode(env) {
  return (env.APP_PASSCODE || '').trim();
}

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/verify') return next();
  const auth = c.req.header('Authorization') || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '').trim();
  const expected = expectedPasscode(c.env);
  if (!expected || token !== expected) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: 'server error' }, 500);
});

async function body(c) {
  return c.req.json().catch(() => ({}));
}

/** Re-arms the reminder alarm after anything that changes the schedule. */
function reschedule(c) {
  c.executionCtx.waitUntil(
    Promise.resolve().then(() => c.env.RESCHEDULE()).catch((err) => console.error('reschedule failed', err))
  );
}

async function tz(c) {
  return (await getSettings(c.env)).timezone;
}

app.get('/api/health', (c) => c.json({ ok: true }));

app.post('/api/auth/verify', async (c) => {
  const { passcode } = await body(c);
  const expected = expectedPasscode(c.env);
  const ok = Boolean(expected) && String(passcode || '').trim() === expected;
  return c.json({ ok }, ok ? 200 : 401);
});

// ---- Board ----

app.get('/api/board', async (c) => {
  const now = Date.now();
  const { settings, projects, activities, unread } = await loadBoardData(c.env, now);
  return c.json({ settings, projects, activities, unread, now });
});

app.get('/api/search', async (c) => {
  return c.json(await searchActivities(c.env, Date.now(), c.req.query('q') || ''));
});

app.get('/api/archive', async (c) => {
  return c.json({ activities: await listArchived(c.env, Date.now(), c.req.query('q') || '') });
});

// ---- Printable sheet ----

app.get('/api/print', async (c) => {
  const now = Date.now();
  const project = c.req.query('project') || 'all';
  const [settings, projects, { activities, lastNotes }] = await Promise.all([
    getSettings(c.env), listProjects(c.env), loadPrintData(c.env),
  ]);
  const sheet = buildPrintSheet({ activities, lastNotes, now, tz: settings.timezone, project });
  return c.json({ settings, projects, project, now, ...sheet });
});

// ---- Activities ----

app.post('/api/activities', async (c) => {
  const input = await body(c);
  const activity = await createActivity(c.env, input, await tz(c));
  reschedule(c);
  return c.json({ activity }, 201);
});

app.get('/api/activities/:id', async (c) => {
  const detail = await getActivityDetail(c.env, c.req.param('id'));
  if (!detail) return c.json({ error: 'not found' }, 404);
  return c.json(detail);
});

app.patch('/api/activities/:id', async (c) => {
  const patch = await body(c);
  const activity = await updateActivity(c.env, c.req.param('id'), patch, await tz(c));
  if (!activity) return c.json({ error: 'not found' }, 404);
  reschedule(c);
  return c.json({ activity });
});

app.post('/api/activities/:id/restore', async (c) => {
  const activity = await restoreActivity(c.env, c.req.param('id'), await tz(c));
  if (!activity) return c.json({ error: 'not found' }, 404);
  reschedule(c);
  return c.json({ activity });
});

app.delete('/api/activities/:id', async (c) => {
  await deleteActivity(c.env, c.req.param('id'));
  reschedule(c);
  return c.json({ ok: true });
});

app.put('/api/activities/:id/reminders', async (c) => {
  const { offsets } = await body(c);
  const reminders = await setReminders(c.env, c.req.param('id'), offsets);
  if (!reminders) return c.json({ error: 'not found' }, 404);
  reschedule(c);
  return c.json({ reminders });
});

// ---- Notes (work log) ----

app.post('/api/activities/:id/notes', async (c) => {
  const { body: text } = await body(c);
  const note = await addNote(c.env, c.req.param('id'), text);
  if (!note) return c.json({ error: 'not found' }, 404);
  return c.json({ note }, 201);
});

app.patch('/api/notes/:id', async (c) => {
  const { body: text } = await body(c);
  const note = await editNote(c.env, c.req.param('id'), text);
  if (!note) return c.json({ error: 'not found' }, 404);
  return c.json({ note });
});

app.delete('/api/notes/:id', async (c) => {
  await deleteNote(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Projects ----

app.post('/api/projects', async (c) => {
  const project = await createProject(c.env, await body(c));
  return c.json({ project }, 201);
});

app.patch('/api/projects/:id', async (c) => {
  const input = await body(c);
  const project = await updateProject(c.env, c.req.param('id'), input);
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({ project });
});

app.delete('/api/projects/:id', async (c) => {
  await deleteProject(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Settings ----

app.put('/api/settings', async (c) => {
  const input = await body(c);
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) return c.json({ error: 'invalid time zone' }, 400);
    await setSetting(c.env, 'timezone', input.timezone);
    await replanAllSchedules(c.env, input.timezone);
    reschedule(c);
  }
  return c.json({ settings: await getSettings(c.env) });
});

// ---- In-app notifications ----

app.get('/api/notifications', async (c) => {
  const [notifications, unread] = await Promise.all([listNotifications(c.env), unreadCount(c.env)]);
  return c.json({ notifications, unread });
});

app.post('/api/notifications/read-all', async (c) => {
  await markAllNotificationsRead(c.env);
  return c.json({ ok: true });
});

app.post('/api/notifications/:id/read', async (c) => {
  await markNotificationRead(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Push ----

app.get('/api/push/vapid-public-key', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', async (c) => {
  const sub = await body(c);
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return c.json({ error: 'invalid subscription' }, 400);
  }
  await saveSubscription(c.env, sub);
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const { endpoint } = await body(c);
  if (endpoint) await removeSubscription(c.env, endpoint);
  return c.json({ ok: true });
});

app.post('/api/push/test', async (c) => {
  const result = await sendPushToAll(c.env, {
    title: 'Test notification',
    body: 'If you can see this, push is wired up correctly.',
    tag: 'test',
  });
  return c.json(result);
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
