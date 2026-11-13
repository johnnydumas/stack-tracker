# Stack

An activity board: a PWA frontend + a Cloudflare Worker backend (D1 + a Durable
Object for reminders), with real push notifications. Runs on your existing
Cloudflare Workers plan.

**What it does:**
- A sticky-note board: **Not started → In progress → Waiting for Update → Completed**.
  Drag notes between columns on desktop, or use each note's **Move ▸** button (handy on phones).
- **Projects** are optional colour-coded tags (one per activity). The dropdown in the
  top-left filters the board to one project, "No project", or everything.
- Every activity has a **work log**: timestamped notes you can edit or delete, plus
  automatic entries when it changes column or due date.
- **Per-column sort and filter** (priority, due date, time in column, manual drag order…),
  remembered on each device. Search covers titles, descriptions, notes *and* the archive.
- Completed activities stay on the board for **14 days**, then move to the **Archive**
  (searchable, with restore).
- **Recurring activities** (daily, weekdays, weekly, every 2 weeks, monthly): completing one
  sends the same card back to Not started with its next due date.
- **Reminders** (phone push + the in-app bell), all in your time zone (default America/Chicago):
  - Optional reminders before the due date, set per activity (at due time, 15 min, 1 hour,
    1 day, 1 week, or custom).
  - Overdue: once every 24 hours starting 24h after the due time, never on weekends —
    a reminder that would land on Saturday/Sunday goes out Monday at the same time.
  - Waiting for Update: a nudge after 3 work days in that column, then every 3 work days.
    Notes in that column show how many work days they've been waiting.
- Installable as an app (PWA). Single shared passcode — built for one person.

---

## 1. Prerequisites

- Node.js 20+
- A Cloudflare account with Workers (you mentioned you already have a paid plan)
- The [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) CLI (installed as a dev dependency, no global install needed)

## 2. Install and log in

```bash
npm install
npx wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account.

## 3. Create the D1 database

```bash
npx wrangler d1 create stack-db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Then run the schema migration:

```bash
npm run db:migrate:remote
```

> **Heads-up:** `schema.sql` drops and recreates every table, so running it on an
> existing database **wipes all data**. That's intended for the move from the old
> task list to the board; don't re-run it afterwards unless you want a clean slate.

(`npm run db:migrate:local` sets up a local copy for `wrangler dev`, if you want
to develop locally first.)

## 4. Generate VAPID keys (for push notifications)

```bash
npx web-push generate-vapid-keys
```

This prints a public and private key pair. You don't need to install anything
extra — `npx` fetches it on demand.

## 5. Set secrets

None of these go in `wrangler.toml` — they're pushed directly to Cloudflare:

```bash
npx wrangler secret put APP_PASSCODE
npx wrangler secret put VAPID_SUBJECT       # e.g. mailto:you@example.com
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

`APP_PASSCODE` is whatever you want to type to unlock the app — pick something
you can enter comfortably on a phone keyboard. It's the only thing standing
between the public internet and your task list, so don't reuse a real password.

## 6. Deploy

```bash
npm run deploy
```

Wrangler prints your `*.workers.dev` URL. Open it, enter your passcode, and tap
the bell icon to enable notifications (this must be done from the deployed
HTTPS URL — push subscriptions don't work over `wrangler dev`'s local HTTP).

### Installing it as an app

On iOS Safari or Android Chrome, open the URL and use "Add to Home Screen." It'll
launch full-screen like a native app from then on.

### How reminders are scheduled

There are no cron jobs. A single Durable Object (`ReminderScheduler` in
`worker/src/scheduler.js`) keeps one alarm set for the next reminder due across all
activities. Whenever an activity is created, edited, moved or deleted, the Worker asks
it to re-plan; when the alarm fires it sends everything that's due (push + in-app
inbox) and sets the next alarm. The first `npm run deploy` creates the Durable Object
automatically (the `[[migrations]]` block in `wrangler.toml`) and removes the old cron
triggers.

The time zone lives in the app under **⋮ → Settings** (default `America/Chicago`).
Due times, weekends and the 24-hour cadence all follow it, including daylight saving.

---

## 7. Push to GitHub

This repo is already git-initialized locally. To publish it:

```bash
gh repo create stack-tracker --private --source=. --remote=origin --push
```

Or without the `gh` CLI:

```bash
git add .
git commit -m "Initial commit: Stack task tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.wrangler/`, and `.dev.vars` —
your secrets never touch the repo since they're stored in Cloudflare, not in
code.

### Continuous deployment (optional)

If you want pushes to `main` to auto-deploy, add a GitHub Actions workflow using
`cloudflare/wrangler-action`, with a `CLOUDFLARE_API_TOKEN` repo secret. Ask
Claude Code to set this up once the repo exists — it's a ~15 line YAML file.

---

## 8. Working on it with Claude Code

The project is split into small, single-purpose files:

```
worker/src/
  index.js      → HTTP routes (Hono)
  db.js         → all D1 queries, status moves, recurrence roll-over
  scheduler.js  → Durable Object: reminder alarms (pre-due, overdue, waiting)
  push.js       → sends web push notifications
  util.js       → labels, formatting, id generation
public/
  index.html    → app shell + passcode gate
  app.js        → all frontend logic (no build step, no framework)
  shared/time.js→ time-zone/weekend math, shared by the Worker and the browser
  style.css     → design tokens + styles (desktop board, mobile swipe tabs)
  sw.js         → service worker (push handling, offline cache)
  manifest.json → PWA install metadata
```

## Local development

```bash
npm run db:migrate:local
echo "APP_PASSCODE=1234" > .dev.vars
npx wrangler dev
```

Note: push notifications require HTTPS, so you can build/test the rest of the
app locally, but test actual push delivery against the deployed version.
