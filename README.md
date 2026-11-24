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
npm run test:other   test/migrate.js (the copy-from-local script) and test/config.js (wrong-setup behaviour)
```

`test/ui.js` also checks the phone: no sideways scroll at 360 and 390 wide, every control at least 44 px, every input 16 px or more, the manifest, icons, fonts and `vercel.json` cache rules. It needs Microsoft Edge and `puppeteer-core` (the path is at the top of that file).

## Rules built in (unchanged)

- No automated sending of anything. You log DMs and emails by hand. Calls are manual.
- No scraping. Leads come in by CSV import or by hand.
- Opted-out leads are blocked on every channel, leave every queue and follow-up list, and cannot be contacted by logging. Removing an opt-out needs you to type REMOVE. Deleting a lead that opted out keeps the opt-out record, so a re-import of that business is still blocked.
- Duplicates are matched on phone, website, or business name plus city, and you are warned before anything is added.
- The call queue shows only leads inside the calling window (default 8 AM to 9 PM in their local time).
