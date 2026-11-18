# Stack

An activity board: a PWA frontend + a Cloudflare Worker backend, with real push
notifications. All data and reminder scheduling live in a single Durable Object
with its own built-in SQLite storage. Runs on your existing Cloudflare Workers plan.

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
- **Print week** (⋮ menu): a one-page US Letter to-do sheet for a binder, covering five
  working days from the day you print (Mon → Mon–Fri, Fri → Fri–Thu, weekend → next
  Mon–Fri). Overdue, due this week (repeats on each weekday they fall), waiting, in
  progress and undated items, each with a checkbox and its latest note, plus a "Top 3
  today" box, a due-per-day strip and ruled notes. Follows the project dropdown.
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

No schema step is needed: the app keeps its data in a Durable Object that creates
its own tables on first start (see "Where the data lives" below). The D1 database
only needs to exist because `wrangler.toml` binds it, for the one-time copy of any
older data.

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

### Where the data lives

All data lives in one Durable Object (`ReminderScheduler`, `worker/src/scheduler.js`)
using its built-in SQLite storage, which sits on the same machine as the code, so
there's no network hop per query. The Worker (`worker/src/index.js`) just forwards
every `/api` request to it. The object creates its own tables on first start.

The D1 database (`stack-db`) is no longer used for live data. It stays bound only so
that, on first start, the Durable Object can copy existing data out of it (once;
it records that it's done). **Don't run `schema.sql` any more** — it only affects D1.

### How reminders are scheduled

There are no cron jobs. The same Durable Object keeps one alarm set for the next
reminder due across all activities, re-plans it whenever an activity is created,
edited, moved or deleted, and when the alarm fires sends everything that's due
(push + in-app inbox) and sets the next alarm.

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
  index.js      → Worker entry: forwards /api requests to the Durable Object
  api.js        → HTTP routes (Hono), run inside the Durable Object
  scheduler.js  → Durable Object: owns the data and the reminder alarms
  store.js      → its SQLite schema, D1-style wrapper, one-time copy from D1
  db.js         → all queries, status moves, recurrence roll-over
  print.js      → which activities make the printed sheet, and the 5-day window
  push.js       → sends web push notifications
  util.js       → labels, formatting, id generation
public/
  index.html    → app shell + passcode gate
  print.html/js/css → printable weekly sheet (Print week)
  app.js        → all frontend logic (no build step, no framework)
  shared/time.js→ time-zone/weekend math, shared by the Worker and the browser
  style.css     → design tokens + styles (desktop board, mobile swipe tabs)
  sw.js         → service worker (push handling, offline cache)
  manifest.json → PWA install metadata
```

## Local development

```bash
echo "APP_PASSCODE=1234" > .dev.vars
npx wrangler dev
```

Note: push notifications require HTTPS, so you can build/test the rest of the
app locally, but test actual push delivery against the deployed version.
