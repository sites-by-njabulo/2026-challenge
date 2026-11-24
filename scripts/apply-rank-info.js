'use strict';
/* Step 2 of 2 for ranking data. Puts the Google Maps ranking (leads.rank_info) on every lead that can be matched to a scrape.

   Usage:  node scripts/apply-rank-info.js --dry-run     (shows what it would do, writes nothing)
           node scripts/apply-rank-info.js               (really writes)

   Needs DATABASE_URL in the environment (the same Supabase string the site uses, Transaction pooler, port 6543).
   Reads scripts/rank-data/rank-lists.json (made by build-rank-data.js). A lead is matched by phone digits, or by its exact website
   page when the phone cannot decide.
   Safe to run again: a lead that already has the same ranking is left alone, a lead whose ranking came from somewhere else
   (typed in by hand, another source) is never overwritten. Nothing but rank_info is touched, not even updated_at. */
const fs = require('fs');
const path = require('path');
const R = require('./rank-lib.js');

const LISTS_FILE = path.join(__dirname, 'rank-data', 'rank-lists.json');
const same = (a, b) => require('node:util').isDeepStrictEqual(a, b); // jsonb stores keys in its own order, so compare the content

/* Does the work on the database the app is already connected to. Returns the numbers. Exported so the tests can run it on PGlite. */
async function applyRankInfo({ lists, dryRun }) {
  const db = require('../src/db');
  const { ensureSchema } = require('../src/schema');
  await ensureSchema(); // adds the rank_info column if this database does not have it yet
  const leads = await db.all('SELECT id, business_name, phone_norm, website, rank_info FROM leads ORDER BY id');
  const out = { leads: leads.length, matched: 0, updated: 0, unchanged: 0, kept_other_source: 0, by_query: {}, changes: [] };
  const todo = [];
  for (const l of leads) {
    const info = R.publicInfo(R.rankInfoFor(l, lists));
    if (!info) continue;
    out.matched++;
    out.by_query[info.query] = (out.by_query[info.query] || 0) + 1;
    const cur = typeof l.rank_info === 'string' ? JSON.parse(l.rank_info) : l.rank_info;
    if (cur && cur.source !== R.SOURCE) { out.kept_other_source++; continue; }
    if (cur && same(cur, info)) { out.unchanged++; continue; }
    todo.push({ id: l.id, info });
    out.changes.push({ id: l.id, business_name: l.business_name, my_rank: info.my_rank, total: info.total, query: info.query });
  }
  if (!dryRun && todo.length) {
    await db.tx(async () => { for (const t of todo) await db.run('UPDATE leads SET rank_info = ?::jsonb WHERE id = ?', JSON.stringify(t.info), t.id); });
    out.updated = todo.length;
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const lists = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8')).lists;
  let res;
  try { res = await applyRankInfo({ lists, dryRun }); } catch (e) {
    if (e && e.constructor && e.constructor.name === 'DbConfigError') { console.log(e.message + '\nSet DATABASE_URL in this window first, then run the command again.'); process.exit(1); }
    throw e;
  }
  console.log((dryRun ? 'DRY RUN, nothing written.\n' : '') + 'Leads in the database: ' + res.leads);
  console.log('Matched to a scrape: ' + res.matched + ' ' + JSON.stringify(res.by_query));
  console.log((dryRun ? 'Would update: ' + res.changes.length : 'Updated: ' + res.updated) + '. Already up to date: ' + res.unchanged + '. Kept (ranking from another source): ' + res.kept_other_source + '.');
  await require('../src/db').close();
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { applyRankInfo };
