import { ReminderScheduler } from './scheduler.js';

export { ReminderScheduler };

// Static files (the app itself) are served straight from Cloudflare's asset
// store and never reach this code. Every /api request is handed to the single
// Durable Object, which holds all the data in its own local database.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const started = Date.now();
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('reminders'));
    const res = await stub.fetch(request);
    const ms = Date.now() - started;
    if (ms > 1000) console.warn(`slow request: ${request.method} ${url.pathname} took ${ms}ms end to end`);

    // Report the Worker -> Durable Object round trip alongside the server's own timings.
    const out = new Response(res.body, res);
    out.headers.append('Server-Timing', `edge;dur=${ms};desc="Worker to storage and back"`);
    return out;
  },
};
