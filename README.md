# Stack

A no-frills task tracker: a PWA frontend + a Cloudflare Worker backend, with real
push notifications. No subscriptions, runs entirely on your existing Cloudflare
Workers plan (Workers, D1, and cron triggers are all on the free tier at this scale).

**What it does:**
- Quick-add tasks with priority, an optional due date, and optional recurrence
- "Today" view that auto-picks what you should be working on (no manual sorting)
- Optional projects — house related tasks together (e.g. everything under one
  Technical Assistance engagement) and see progress per project, while every
  task still also shows up in the flat, ranked Today/All/Stale feeds
- Escalating push notifications for overdue tasks, a heads-up for tasks due soon
- A daily morning planning nudge and a weekly "stale task" digest
- Installable as an app on your phone's home screen, works offline for viewing
- Single shared passcode — this is built for one person (you), not multi-user

It was built and tested locally end-to-end (task CRUD, recurrence, auth, static
asset serving) before being handed to you. You still need to do the one-time
Cloudflare setup below since it requires your account.

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

(If you skip this step, that's OK — the worker applies the schema itself the
first time it touches an empty database.)

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

### Timezone note

The cron schedules in `wrangler.toml` are in UTC:
- `*/15 * * * *` — reminder sweep, every 15 minutes
- `0 8 * * *` — morning planning prompt, 8am UTC
- `0 9 * * 1` — weekly stale digest, Monday 9am UTC

Adjust the hours to match your local time relative to UTC, then redeploy.

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

The project is deliberately split into small, single-purpose files so changes
stay scoped:

```
worker/src/
  index.js      → HTTP routes (Hono)
  db.js         → all D1 queries
  push.js       → sends web push notifications
  scheduled.js  → cron job logic (reminders, prompts, digest)
  util.js       → sorting, recurrence math, id generation
public/
  index.html    → app shell + passcode gate
  app.js        → all frontend logic (no build step, no framework)
  style.css     → design tokens + styles
  sw.js         → service worker (push handling, offline cache)
  manifest.json → PWA install metadata
```

Some natural next things to ask Claude Code for, in rough order of usefulness:
- Task editing (currently you can complete/delete but not edit title/notes/due date after creation)
- Subtasks or checklists
- A "snooze" button with a visible snooze count, per the earlier discussion of flagging repeatedly-deferred tasks
- Swipe-to-delete on mobile instead of a tap target
- Self-hosting the Google Fonts instead of loading them from a CDN, for full offline support

## Local development

```bash
npm run db:migrate:local
npx wrangler dev
```

Note: push notifications require HTTPS, so you can build/test the rest of the
app locally, but test actual push delivery against the deployed version.
