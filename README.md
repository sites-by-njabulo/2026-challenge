# Lead Tracker

One record per business, every contact attempt on its timeline. A business you called, DMed and emailed is one lead, not three.

## Run it

1. Double-click `start.cmd` (or run `node --no-warnings server.js` in this folder). Needs Node 22.13 or newer. Nothing to install.
2. Open http://127.0.0.1:4310
3. First visit: choose a password (8 or more characters). Leads stay on this computer in `data/tracker.db`.

Optional, to use it on your phone on the same Wi-Fi: `set HOST=0.0.0.0` before `start.cmd`, then open `http://<this PC's IP>:4310`. That connection is not encrypted, so only do it on a network you trust.

Demo data: `node --no-warnings seed.js` adds 10 fake leads tagged Demo. Remove them in Settings, Demo data, before you start with real leads.

## Stack

Node's built-in SQLite database, a small web server with no packages, plain HTML, CSS and JavaScript. Login is a password you set (stored hashed), kept in a cookie. Fonts (IBM Plex) load from Google Fonts and fall back to system fonts offline.

## What is where

- `server.js` the API, database, import, export, backups, login
- `public/` the screens: Today, Leads, lead page, Pipeline, Stats, Settings, CSV import
- `public/lib.js` shared rules: time zones and the 8 AM to 9 PM window, duplicate keys, CSV
- `data/` your database and backups (not for git)
- `test/flow.js` end to end API test, `test/ui.js` browser test with screenshots
- `seed.js` demo data

## Rules built in

- No automated sending of anything. You log DMs and emails by hand. Calls are manual (a Call button opens your phone app, it does not dial by itself).
- No scraping. Leads come in by CSV import or by hand.
- Opted-out leads are blocked on every channel, leave every queue and follow-up list, and cannot be contacted by logging. Removing an opt-out needs you to type REMOVE. Deleting a lead that opted out keeps the opt-out record, so a re-import of that business is still blocked.
- Duplicates are matched on phone, website, or business name plus city, and you are warned before anything is added.
- The call queue shows only leads inside the calling window (default 8 AM to 9 PM in their local time). Some states set tighter hours: narrow the window in Settings if you call those states.

## Backups

A copy of the database is made when the server starts, every 3 hours while it runs, after each import, and when you press Back up now in Settings. The newest 60 are kept in `data/backups/`. To restore, stop the server and copy a backup over `data/tracker.db`.

## Left room for later (not built)

- Phase 2, Instantly: email is already a channel. Every lead and every contact entry has an `external_id` field, so sends, replies and bounces can be matched to the right lead without changing the data.
- Phase 3, content tracking: a separate table (what you posted, where, views, which posts brought leads) can be added next to the leads table.
