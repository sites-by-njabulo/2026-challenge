'use strict';
/* Tests scripts/migrate-from-local.js: builds a small old-style SQLite tracker file (the exact tables the local tracker used),
   copies it into an in-process Postgres (PGlite) and checks that nothing was lost or changed.
   Run: node --no-warnings test/migrate.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

delete process.env.DATABASE_URL;
Object.assign(process.env, { TEST_PGLITE: '1', APP_SECRET: 'migrate-test-secret-1234567890', SETUP_TOKEN: 'migrate-test-token' });
const db = require('../src/db');
const app = require('../src/app');
const { migrate } = require('../scripts/migrate-from-local.js');

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); };

const OLD_SCHEMA = `
CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT NOT NULL, owner_name TEXT, phone TEXT, phone_norm TEXT, email TEXT, email_norm TEXT,
  website TEXT, website_norm TEXT, city TEXT, state TEXT, trade TEXT, source TEXT NOT NULL DEFAULT 'other', source_link TEXT, batch TEXT, timezone TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'new', next_followup TEXT, competitor_checked TEXT, competitor_checked_date TEXT, opted_out INTEGER NOT NULL DEFAULT 0, opt_out_date TEXT,
  opt_out_channel TEXT, external_id TEXT, is_demo INTEGER NOT NULL DEFAULT 0, name_city_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE, channel TEXT NOT NULL, outcome TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out', content TEXT, note TEXT, at TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL, mailbox TEXT);
CREATE TABLE deals (lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE, call_at TEXT, call_result TEXT, proposal_sent_date TEXT, deposit_paid_date TEXT,
  deposit_amount REAL, signed_date TEXT, deal_value REAL, updated_at TEXT);
CREATE TABLE opt_outs (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, business_name TEXT, phone_norm TEXT, email_norm TEXT, website_norm TEXT, name_city_key TEXT,
  at TEXT NOT NULL, channel TEXT NOT NULL, note TEXT, removed_at TEXT, removed_note TEXT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE call_tally (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, dials INTEGER NOT NULL DEFAULT 0, conversations INTEGER NOT NULL DEFAULT 0, meetings INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE call_day (day TEXT PRIMARY KEY, calls_adj INTEGER NOT NULL DEFAULT 0, reached_adj INTEGER NOT NULL DEFAULT 0, owner_adj INTEGER NOT NULL DEFAULT 0, good_adj INTEGER NOT NULL DEFAULT 0, verdict TEXT, updated_at TEXT);
CREATE TABLE outreach_adj (day TEXT NOT NULL, key TEXT NOT NULL, adj INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key));
CREATE TABLE email_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at TEXT NOT NULL, payload TEXT NOT NULL);
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-migrate-'));
  const file = path.join(dir, 'tracker.db');
  const old = new DatabaseSync(file);
  old.exec(OLD_SCHEMA);
  const T = '2026-11-20T10:00:00.000Z';
  const lead = old.prepare("INSERT INTO leads(id, business_name, phone, phone_norm, city, state, trade, source, status, next_followup, opted_out, name_city_key, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  lead.run(5, 'Alpha Roofing', '(615) 555-0101', '6155550101', 'Nashville', 'TN', 'Roofer', 'google_maps', 'follow_up', '2026-11-30', 0, 'alpharoofing|nashville', T, T);
  lead.run(9, 'Beta Plumbing', '(303) 555-0102', '3035550102', 'Denver', 'CO', 'Plumber', 'instagram', 'closed', null, 0, 'betaplumbing|denver', T, T);
  lead.run(12, 'Gamma HVAC', '(602) 555-0103', '6025550103', 'Phoenix', 'AZ', 'HVAC', 'referral', 'new', null, 1, 'gammahvac|phoenix', T, T);
  const c = old.prepare("INSERT INTO contacts(id, lead_id, channel, outcome, direction, content, note, at, mailbox, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  c.run(1, 5, 'call', 'no_answer', 'out', 'Rang out', null, '2026-11-21T14:00:00.000Z', null, T);
  c.run(2, 5, 'email', 'sent', 'out', 'First email', null, '2026-11-22T14:00:00.000Z', 'jay@example.test', T);
  c.run(7, 9, 'instagram_dm', 'replied', 'in', 'Yes please', null, '2026-11-22T15:00:00.000Z', null, T);
  old.prepare('INSERT INTO deals(lead_id, call_at, call_result, signed_date, deal_value, deposit_amount, updated_at) VALUES(?,?,?,?,?,?,?)').run(9, '2026-11-25T10:00:00.000Z', 'show', '2026-11-26', 1250.5, 600, T);
  old.prepare('INSERT INTO opt_outs(id, lead_id, business_name, phone_norm, at, channel, note) VALUES(?,?,?,?,?,?,?)').run(3, 12, 'Gamma HVAC', '6025550103', T, 'all', 'Asked to stop');
  old.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('password_hash', 'salt:oldhash');
  old.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('zapmail_key_enc', 'OLDENCRYPTEDKEY');
  old.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('daily_call_target', '70');
  old.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('goal_amount', '5000');
  old.prepare('INSERT INTO sessions(token_hash, created_at, expires_at) VALUES(?,?,?)').run('x', T, T);
  old.prepare("INSERT INTO call_day(day, calls_adj, verdict) VALUES('2026-11-22', 12, 'Good day')").run();
  old.prepare("INSERT INTO outreach_adj(day, key, adj) VALUES('2026-11-22', 'instagram_dm', 4)").run();
  old.prepare("INSERT INTO email_snapshots(taken_at, payload) VALUES(?, ?)").run(T, JSON.stringify({ mailboxes: [] }));
  old.close();

  try {
    const lines = [];
    const pv = await migrate(file, { commit: false, log: (l) => lines.push(l) });
    check('preview says what it would copy and writes nothing', pv.committed === false && pv.counts.leads === 3 && (await db.get('SELECT COUNT(*) AS n FROM leads')).n === 0 && /Preview only/.test(lines.join('\n')), [pv, lines]);
    const res = await migrate(file, { commit: true, log: () => {} });
    check('commit copies every row of every table', res.committed && res.counts.leads === 3 && res.counts.contacts === 3 && res.counts.deals === 1 && res.counts.opt_outs === 1 && res.counts.call_day === 1 && res.counts.outreach_adj === 1 && res.counts.email_snapshots === 1, res);
    const l9 = await db.get('SELECT * FROM leads WHERE id = 9');
    check('lead numbers, status and fields are kept exactly', l9.business_name === 'Beta Plumbing' && l9.status === 'closed' && l9.source === 'instagram' && l9.phone_norm === '3035550102', l9);
    const ct = await db.all('SELECT * FROM contacts WHERE lead_id = 5 ORDER BY id');
    check('the timeline entries and the mailbox on emails are kept', ct.length === 2 && ct[1].mailbox === 'jay@example.test' && ct[0].at === '2026-11-21T14:00:00.000Z', ct);
    const dl = await db.get('SELECT * FROM deals WHERE lead_id = 9');
    check('the deal keeps its amounts', dl.deal_value === 1250.5 && dl.deposit_amount === 600 && dl.call_result === 'show', dl);
    check('the opted-out lead and its opt-out record are kept', (await db.get('SELECT opted_out FROM leads WHERE id = 12')).opted_out === 1 && (await db.get('SELECT note FROM opt_outs WHERE id = 3')).note === 'Asked to stop', 1);
    check('daily counters and verdicts are kept', (await db.get("SELECT verdict FROM call_day WHERE day = '2026-11-22'")).verdict === 'Good day' && (await db.get("SELECT adj FROM outreach_adj WHERE key = 'instagram_dm'")).adj === 4, 1);
    const set = await app.getSettings();
    check('targets and goal settings come across', set.daily_call_target === 70 && set.goal_amount === 5000, set);
    check('the old password, sessions and Zapmail key are NOT copied', (await db.get("SELECT COUNT(*) AS n FROM settings WHERE key IN ('password_hash', 'zapmail_key_enc')")).n === 0 && (await db.get('SELECT COUNT(*) AS n FROM sessions')).n === 0, 1);
    const fresh = await db.get("INSERT INTO leads(business_name, created_at, updated_at) VALUES('Delta', 'x', 'x') RETURNING id");
    const freshContact = await db.get("INSERT INTO contacts(lead_id, channel, outcome, \"at\", created_at) VALUES(5, 'call', 'voicemail', 'x', 'x') RETURNING id");
    check('new leads and entries carry on after the copied numbers (no clashes)', fresh.id === 13 && freshContact.id === 8, [fresh, freshContact]);
    await db.run('DELETE FROM leads WHERE id = 13');
    let refused = '';
    try { await migrate(file, { commit: true, log: () => {} }); } catch (e) { refused = e.message; }
    check('running it again is refused because the cloud tracker is no longer empty', /already has 3 leads/.test(refused), refused);
    const stillThere = new DatabaseSync(file, { readOnly: true });
    check('the old file was only read: it still has its 3 leads', stillThere.prepare('SELECT COUNT(*) AS n FROM leads').get().n === 3, 1);
    stillThere.close();
    check('the tracker itself opens normally on the copied data', (await db.get('SELECT COUNT(*) AS n FROM leads')).n === 3, 1);
  } catch (e) {
    check('migration test crashed', false, e.stack);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const bad = results.filter((x) => !x.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed.`);
    process.exit(bad.length ? 1 : 0);
  }
})();
