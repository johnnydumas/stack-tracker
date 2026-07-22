import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  listAllTasks, listOpenTasks, createTask, updateTask, deleteTask,
  touchTask, saveSubscription, removeSubscription, ensureSchema,
  listActivities, createActivity, renameActivity, deleteActivity,
  getSettings, updateSettings,
} from './db.js';
import { pickTodayTasks, pickStaleTasks } from './util.js';
import { sendPushToAll } from './push.js';
import { handleScheduled } from './scheduled.js';

const app = new Hono();

app.use('/api/*', cors({ origin: '*' }));

// Every /api/* route (except the passcode check itself) requires the
// passcode to be sent as `Authorization: Bearer <passcode>`.
function expectedPasscode(env) {
  return (env.APP_PASSCODE || '').trim();
}

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/verify') return next();
  const auth = c.req.header('Authorization') || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '').trim();
  const expected = expectedPasscode(c.env);
  if (!expected || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await ensureSchema(c.env);
  return next();
});

// Surface unexpected failures as JSON (the frontend expects an
// { error } body) instead of Hono's default plain-text 500.
app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: err.message || 'internal error' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.post('/api/auth/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const expected = expectedPasscode(c.env);
  const submitted = String(body.passcode || '').trim();
  const ok = Boolean(expected) && submitted === expected;
  return c.json({ ok }, ok ? 200 : 401);
});

// ---- Tasks ----

app.get('/api/tasks', async (c) => {
  const view = c.req.query('view') || 'all';
  const now = Date.now();

  if (view === 'today') {
    const open = await listOpenTasks(c.env);
    return c.json({ tasks: pickTodayTasks(open, now) });
  }
  if (view === 'stale') {
    const open = await listOpenTasks(c.env);
    return c.json({ tasks: pickStaleTasks(open, now) });
  }
  const all = await listAllTasks(c.env);
  return c.json({ tasks: all });
});

app.post('/api/tasks', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const task = await createTask(c.env, body);
    return c.json({ task }, 201);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { task, spawned } = await updateTask(c.env, id, body);
  if (!task) return c.json({ error: 'not found' }, 404);
  return c.json({ task, spawned });
});

app.post('/api/tasks/:id/touch', async (c) => {
  await touchTask(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

app.delete('/api/tasks/:id', async (c) => {
  await deleteTask(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Activities ----

app.get('/api/activities', async (c) => {
  const activities = await listActivities(c.env);
  return c.json({ activities });
});

app.post('/api/activities', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const activity = await createActivity(c.env, body);
    return c.json({ activity }, 201);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch('/api/activities/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const found = await renameActivity(c.env, c.req.param('id'), body.title);
    if (!found) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.delete('/api/activities/:id', async (c) => {
  await deleteActivity(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Settings ----

app.get('/api/settings', async (c) => {
  const settings = await getSettings(c.env);
  return c.json({ settings });
});

app.patch('/api/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = await updateSettings(c.env, body);
  return c.json({ settings });
});

// ---- Push ----

app.get('/api/push/vapid-public-key', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', async (c) => {
  const sub = await c.req.json().catch(() => null);
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return c.json({ error: 'invalid subscription' }, 400);
  }
  await saveSubscription(c.env, sub);
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.endpoint) await removeSubscription(c.env, body.endpoint);
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

export default {
  fetch: app.fetch,
  scheduled: async (event, env, ctx) => {
    ctx.waitUntil(handleScheduled(event, env));
  },
};