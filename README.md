# Lead Tracker (cloud version)

One record per business, every contact attempt on its timeline. A business you called, DMed and emailed is one lead, not three.

This is the same app as the local Lead Tracker, ported to run on **Vercel** (serverless) with a **Supabase** Postgres database, so it opens from a phone.
To put it online, follow [DEPLOY.md](DEPLOY.md). The local tracker in the `Lead Tracker` folder is untouched and still works.

## How it is built

- `public/` the screens (plain HTML, CSS and ES modules, no build step). Vercel serves this folder as static files. Same screens as the local app. Built phone first: bottom tabs, 44 px tap targets, 16 px inputs, safe areas for the iPhone notch and home bar. Only Today loads up front, the other screens load the first time you open them. `manifest.webmanifest`, `icons/` and `fonts/` make it installable to the home screen; `scripts/make-icons.js` redraws the icons with plain Node.
- `api/index.js` the one serverless function. `vercel.json` sends every `/api/*` request to it, with a 60 second limit.
- `src/app.js` the whole API (routes, rules, import, export, Zapmail sync, login). One `(req, res)` handler.
- `src/db.js` the only door to the database: `pg` over `DATABASE_URL` in production (one connection per instance, no named prepared statements, so it works with the Supabase pooler in transaction mode on port 6543).
- `src/schema.js` creates the tables on first connection, turns on Row Level Security on every table with no policies, and checks again on every cold start.
- `dev-server.js` serves `public/` and the same handler on your own computer. Not used on Vercel.
- `seed.js` demo data. `scripts/` Google Maps import, Zapmail snapshot file import, and `migrate-from-local.js` (copies the old local tracker into the cloud one).
- `test/` three test suites, see below.

## Settings (environment variables)

| Name | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Transaction pooler string (port 6543), password filled in and URL-encoded. `DATABASE_SSL=off` turns TLS off (only for a local Postgres). |
| `APP_SECRET` | yes, 16+ characters | Encrypts the saved Zapmail key (AES-256-GCM, key made from it with scrypt). Changing it means pasting the Zapmail key again. |
| `SETUP_TOKEN` | yes, 8+ characters | The first-run "set a password" step refuses without it. Once a password exists, setup is closed. |
| `CRON_SECRET` | yes, 16+ characters | The daily Vercel cron calls `GET /api/cron/zapmail` with `Authorization: Bearer <CRON_SECRET>`. Vercel sends it by itself when this variable exists. |
| `TEST_PGLITE=1` | tests only | With no `DATABASE_URL`, use a throwaway in-process Postgres (PGlite). Without `DATABASE_URL` and without this, the app refuses to start. |

## What changed from the local version

- Everything is async and talks to Postgres. Times and dates are still stored as text exactly as before, so every counting rule is unchanged.
- No files on disk. Sessions, the password hash, settings and the encrypted Zapmail key are table rows. `data/.secret` became `APP_SECRET`.
- **First-run security:** setting the first password needs `SETUP_TOKEN`. Login lockout (6 wrong tries, 10 minutes) now lives in a table, so it holds across serverless instances. The CSRF origin check stays. The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` on https.
- **Zapmail refresh:** a timer cannot run on serverless. It refreshes when the Email page opens (if older than 5 minutes), every 5 minutes while the page is open, on the Refresh button, and once a day from a Vercel cron (Hobby plan allows one a day). The 3-hourly refresh is gone.
- **Backups:** the local `VACUUM INTO` backups are gone (Settings, Backups now explains this honestly). Supabase keeps its own backups, and Export (zip or CSV) still works as your own copy.
- Import and duplicate checks do their database lookups in bulk (a few queries for a whole file, not a few per row), because the database is a network away.
- Request bodies are limited to about 4.4 MB (Vercel allows 4.5 MB). That is roughly 10,000 simple lead rows per import file.
- The old Windows autostart scripts and `start.cmd` were dropped. They only made sense for a long-running local process.

## Run it on your computer

```
npm install
set TEST_PGLITE=1        (PowerShell: $env:TEST_PGLITE = "1")
npm start                 then open http://127.0.0.1:4310
```

`TEST_PGLITE=1` is a throwaway database in memory. To try it against Supabase instead, set `DATABASE_URL`, `APP_SECRET` and `SETUP_TOKEN` and leave `TEST_PGLITE` out.

## Tests

You cannot reach Supabase from the tests, so they run against PGlite (real Postgres compiled to WebAssembly).

```
npm run test:all     everything below, one after the other
npm test             API suite (test/flow.js) on PGlite
npm run test:ui      browser suite (test/ui.js) on PGlite
npm run test:pg      both of those again through the real `pg` package over a Postgres connection (the production path)
npm run test:other   test/migrate.js (the copy-from-local script), test/config.js (wrong-setup behaviour) and test/rank.js (the ranking data scripts)
```

`test/ui.js` also checks the phone: no sideways scroll at 360 and 390 wide, every control at least 44 px, every input 16 px or more, the manifest, icons, fonts and `vercel.json` cache rules. It needs Microsoft Edge and `puppeteer-core` (the path is at the top of that file).

## Owner odds

Each lead can carry **Owner odds** (High, Medium or Low): how likely it is that the person who answers the phone is the owner. It comes in with the CSV import (columns `owner_odds` and `owner_odds_score`, score 0 to 100; "High", "med" and "medium" are all understood, anything else is left empty) or you set it by hand on the lead page or in Add/Edit lead.

- Leads, Calls queue and Follow-ups show a small chip ("High odds") on each lead that has it. Today does not.
- Leads, behind "Filters and sort": an **Owner odds** filter and the sort **Best odds first** (High, then Medium, then Low, then none, best score first). The API takes `owner_odds=HIGH|MEDIUM|LOW|none` and `sort=odds`.
- The Calls queue lists High first, then Medium, then Low, then leads with no odds, and keeps the old order inside each group. Who is in the queue and every count stay exactly as before.
- Import in "Fill blank fields" mode only fills odds on leads that have none (the score goes with it).
- Database: two optional columns on `leads` (`owner_odds TEXT`, `owner_odds_score INTEGER`). `src/schema.js` adds them with `ADD COLUMN IF NOT EXISTS` on the first request after a deploy, so the existing Supabase table keeps all its rows. Nothing to run by hand.

## Ranking data and the Open panel (Calls page)

Each lead in the call queue has three buttons: **Call**, **Log call** and a small **Open**. Open shows a light quick look without leaving the Calls page: business name, owner (with the owner odds label), phone with a small Call button, city and state, a website link, where the business ranks on Google Maps, and the top 3 competitors (position, name, rating, reviews, phone). It has no script, no log form, no notes and no status controls. Esc or Close shuts it and focus goes back to the Open button.

- Database: one optional column on `leads`, `rank_info JSONB` = `{ query, my_rank, total, top3: [{ rank, name, rating, reviews, phone }], source, checked_at }`. `src/schema.js` adds it with `ADD COLUMN IF NOT EXISTS` on the first request after a deploy, nothing to run by hand.
- API: the call queue rows (`GET /api/calls`, ready rows only) carry `rank_info` and `website`, so Open is instant. `GET /api/leads/:id` returns `rank_info`; the Leads list only carries `has_rank_info`. It can be set with PATCH, with the `rank_info` column of a CSV import (a bad cell is ignored, "Fill blank fields" mode only fills leads that have none) and it is a column of the leads CSV export.
- Where the numbers come from: a Google Maps scrape is the list of businesses in Google's result order for one search, so position in the file is the rank for that search. A business counts at its first position only, and supply stores, HVAC only, electricians and inspectors are skipped (franchises like Roto-Rooter count). The panel always says "Seen on the day the list was scraped" and warns that rankings move and shift by where the searcher is. It never invents a rank: with no data it says "No ranking data for this one yet."
- Putting the data in (two steps, neither touches the database until you run step 2):
  1. `node scripts/build-rank-data.js` reads the three raw scrapes (West Chester, Norristown, Coatesville) and writes `scripts/rank-data/`: `rank-lists.json`, `rank-matches.csv/.json` to look over, `rank-info-import.csv` for the Import page (mode "Fill blank fields") and `rank-info.sql` for the Supabase SQL editor.
  2. `node scripts/apply-rank-info.js --dry-run` then `node scripts/apply-rank-info.js` (needs `DATABASE_URL`). It matches leads by phone digits (or the exact website page when the phone cannot decide), only writes `rank_info`, never overwrites a ranking that came from another source, and is safe to run again.

## My day starts at 3 AM

The Settings page has **My day starts at (hour, 0 to 6)**, default 3. Work after midnight and the counters keep counting the same day until that hour: a call at 01:30 SAST on the 26th counts in the 25th, one at 03:05 counts in the 26th. It applies to everything that is *my* day: Today and the date line, Reached out today (calls, Instagram, Facebook, emails), the dials meter, the scoreboard and its day arrows, Stats, follow-ups due, automatic follow-up dates, the goal countdown and the "cannot log a day that has not happened yet" check. It never touches a lead's own clock: the calling window, the lead's local time and the pick-up hours use the lead's real time zone. Set it to 0 for the old midnight behaviour. Nothing is stored per day, so past history simply re-buckets by the new rule, no migration. In code: `Lib.myDayKey(date, tz, startHour)`, while `Lib.dayKey` is unchanged.

## Rules built in (unchanged)

- No automated sending of anything. You log DMs and emails by hand. Calls are manual.
- No scraping. Leads come in by CSV import or by hand.
- Opted-out leads are blocked on every channel, leave every queue and follow-up list, and cannot be contacted by logging. Removing an opt-out needs you to type REMOVE. Deleting a lead that opted out keeps the opt-out record, so a re-import of that business is still blocked.
- Duplicates are matched on phone, website, or business name plus city, and you are warned before anything is added.
- The call queue shows only leads inside the calling window (default 8 AM to 9 PM in their local time).
