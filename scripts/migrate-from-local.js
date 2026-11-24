'use strict';
/* Moves everything from the old local tracker (a tracker.db file) into the cloud database, keeping lead numbers,
   statuses, follow-ups, every logged call and message, deals, opt-outs, daily counters and settings.
   It only READS the old file. It refuses to run if the cloud tracker already has leads in it.

   Safest way: in the OLD tracker open Settings and press "Back up now", then use the newest file in its data/backups folder
   (a backup is one plain file, so nothing is being written while this reads it).

   Preview (writes nothing):   node --no-warnings scripts/migrate-from-local.js "<path to tracker or backup .db>"
   Really copy it:             node --no-warnings scripts/migrate-from-local.js "<path to .db>" --commit
   Needs DATABASE_URL in the environment (the same Supabase string the site uses).
   Columns are matched by name, so owner_odds and owner_odds_score are copied too if the old file has them (the older local tracker does not).
   Not copied on purpose: the old password (you set a new one), sessions, and the saved Zapmail key (paste it again on the Email page). */
const db = require('../src/db');
const { ensureSchema } = require('../src/schema');

const SETTING_KEYS = ['daily_call_target', 'daily_dm_target', 'goal_amount', 'goal_date', 'my_timezone', 'call_window_start', 'call_window_end', 'email_daily_per_mailbox', 'email_checklist', 'call_script'];
// order matters: leads first, because the rest point at them
const TABLES = [
  { name: 'leads', identity: true }, { name: 'contacts', identity: true }, { name: 'deals' }, { name: 'opt_outs', identity: true },
  { name: 'call_day' }, { name: 'outreach_adj' }, { name: 'call_tally', identity: true }, { name: 'email_snapshots', identity: true },
];

async function migrate(file, opts) {
  const commit = !!(opts && opts.commit);
  const log = (opts && opts.log) || console.log;
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    await ensureSchema();
    const already = (await db.get('SELECT COUNT(*) AS n FROM leads')).n;
    if (already) throw new Error('The cloud tracker already has ' + already + ' leads. This script only fills an empty one, so nothing was copied.');

    const have = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const plan = [];
    for (const t of TABLES) {
      if (!have.has(t.name)) { plan.push({ ...t, rows: [], missing: true }); continue; }
      plan.push({ ...t, rows: src.prepare('SELECT * FROM ' + t.name).all().map((r) => ({ ...r })) });
    }
    const settings = have.has('settings') ? src.prepare('SELECT key, value FROM settings').all().filter((r) => SETTING_KEYS.includes(r.key)) : [];
    for (const p of plan) log((commit ? 'Copying ' : 'Would copy ') + String(p.rows.length).padStart(6) + '  ' + p.name + (p.missing ? '  (table not in the old file)' : ''));
    log((commit ? 'Copying ' : 'Would copy ') + String(settings.length).padStart(6) + '  settings');
    if (!commit) { log('\nPreview only. Nothing was written. Add --commit to copy.'); return { committed: false, counts: Object.fromEntries(plan.map((p) => [p.name, p.rows.length])) }; }

    await db.tx(async () => {
      for (const p of plan) {
        if (!p.rows.length) continue;
        const target = (await db.all("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?", p.name)).map((c) => c.column_name);
        const cols = Object.keys(p.rows[0]).filter((c) => target.includes(c));
        const per = Math.max(1, Math.floor(20000 / cols.length));
        for (let i = 0; i < p.rows.length; i += per) {
          const part = p.rows.slice(i, i + per);
          const marks = part.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
          const args = [];
          for (const r of part) for (const c of cols) args.push(r[c] === undefined ? null : r[c]);
          await db.run(`INSERT INTO ${p.name}(${cols.map((c) => (c === 'at' ? '"at"' : c)).join(',')}) VALUES ${marks}`, ...args);
        }
        if (p.identity) await db.run(`SELECT setval(pg_get_serial_sequence('${p.name}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${p.name}))`);
      }
      for (const s of settings) await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', s.key, s.value);
    });

    const counts = {};
    for (const p of plan) {
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${p.name}`)).n;
      counts[p.name] = n;
      if (n !== p.rows.length) throw new Error('Count mismatch in ' + p.name + ': copied ' + n + ' of ' + p.rows.length + '.');
    }
    log('\nDone. Every table in the cloud database has the same number of rows as the old file.');
    return { committed: true, counts };
  } finally {
    src.close();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) { console.log('Give the path to the old tracker.db (or a backup copy of it).'); process.exit(1); }
  migrate(file, { commit: process.argv.includes('--commit') })
    .then(() => db.close())
    .catch(async (e) => { console.error(e.message); await db.close(); process.exit(1); });
}
