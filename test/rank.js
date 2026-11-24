'use strict';
/* Tests for the ranking data scripts (scripts/rank-lib.js, scripts/apply-rank-info.js). No server, no network.
   The apply script runs against an in-process Postgres (PGlite). Run: node --no-warnings test/rank.js */
delete process.env.DATABASE_URL;
process.env.TEST_PGLITE = '1';
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scripts/rank-lib.js');
const { applyRankInfo } = require('../scripts/apply-rank-info.js');
const Lib = require('../public/lib.js');
const db = require('../src/db');
const { ensureSchema } = require('../src/schema');

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); }

const HEAD = ['hfpxzc href', 'xxVWCe', 'qBF1Pd', 'MW4etd', 'UY7F9', 'W4Efsd', 'UsdlK', 'lcr4fd href'];
const place = (id, lat, lon) => 'https://www.google.com/maps/place/x/data=!4m7!3m6!1s0x89c6:0x' + id + '!8m2!3d' + lat + '!4d' + lon + '!16s%2Fg%2F1';
const row = (id, name, rating, reviews, cat, phone, site, lat, lon) => [place(id, lat || 40.1, lon || -75.3), name + ' · Visited link', name, rating, reviews, cat, phone, site];
function scrape(rows) { return Lib.toCSV([HEAD, HEAD.map(() => ''), HEAD.map(() => ''), ...rows]); }

const csv = scrape([
  row('a1', 'Alpha Plumbing', '4.9', '(1,094)', 'Plumber', '+1 610-555-0001', 'https://alpha.example/'),
  row('b2', 'Big Supply Co', '4.2', '(12)', 'Plumbing supply store', '+1 610-555-0099', 'https://bigsupply.example/'),
  row('c3', 'Bravo Roto-Rooter Plumbing', '4.5', '(3,2K)', 'Plumber', '+1 610-555-0002', 'https://rotorooter.example/'),
  row('d4', 'Cool HVAC Only', '4.4', '(80)', 'HVAC contractor', '+1 610-555-0098', ''),
  row('a1', 'Alpha Plumbing', '4.9', '(1,094)', 'Plumber', '+1 610-555-0001', 'https://alpha.example/'), // seen again while scrolling
  row('e5', 'Delta Heating & Plumbing', '4.1', '(55)', 'HVAC contractor', '+1 610-555-0004', ''),
  row('f6', 'Echo Drain Co', '', '', 'Plumber', '', 'https://echo.example/'),
  row('g7', 'Foxtrot Plumbing', '5', '(7)', 'Plumber', '+1 610-555-0006', 'https://rotorooter.example/'),
  row('h8', 'Inspector Gadget', '4.0', '(3)', 'Building inspector', '+1 610-555-0097', ''),
]);
const parsed = R.parseScrape(csv);
const list = R.toList(parsed, { query: 'plumber in Testville PA', checked_at: '2026-11-25' });

check('parser: the empty first rows are ignored and a business seen again counts once, at its first position', parsed.raw_rows === 9 && parsed.repeats === 1 && parsed.items.length === 8, [parsed.raw_rows, parsed.repeats]);
check('parser: supply stores, HVAC only and inspectors are skipped, they take no position', list.skipped_not_plumbers.length === 3 && /Big Supply/.test(list.skipped_not_plumbers[0]) && /Cool HVAC/.test(list.skipped_not_plumbers.join()) && /Inspector/.test(list.skipped_not_plumbers.join()), list.skipped_not_plumbers);
check('parser: ranks run 1 to 5 over plumbers only, in Google order', list.entries.map((e) => e.rank + ':' + e.name).join('|') === '1:Alpha Plumbing|2:Bravo Roto-Rooter Plumbing|3:Delta Heating & Plumbing|4:Echo Drain Co|5:Foxtrot Plumbing' && list.total === 5, list.entries.map((e) => e.name));
check('parser: a franchise like Roto-Rooter counts as a plumber', list.entries[1].rank === 2, 1);
check('parser: an HVAC listing with Plumbing in its name counts', list.entries[2].name === 'Delta Heating & Plumbing', 1);
check('parser: ratings and review counts are read (1,094 and 3,2K)', list.entries[0].rating === 4.9 && list.entries[0].reviews === 1094 && list.entries[1].reviews === 3200 && list.entries[3].rating === null && list.entries[3].reviews === null, list.entries.map((e) => [e.rating, e.reviews]));

const alpha = R.rankInfoFor({ phone: '(610) 555-0001' }, [list]);
check('match by phone digits in any format: rank 1 of 5, query and date carried', alpha && alpha.my_rank === 1 && alpha.total === 5 && alpha.query === 'plumber in Testville PA' && alpha.checked_at === '2026-11-25' && alpha.source === 'google-maps-scrape', alpha);
check('a lead in the top 3 gets the next three as competitors (ranks 2, 3, 4)', alpha.top3.map((t) => t.rank).join() === '2,3,4' && alpha.top3.every((t) => t.name !== 'Alpha Plumbing'), alpha.top3);
const delta = R.rankInfoFor({ phone: '610.555.0004' }, [list]);
check('a lead at rank 3 shows the best three others (1, 2, 4)', delta.my_rank === 3 && delta.top3.map((t) => t.rank).join() === '1,2,4', delta.top3);
const foxtrot = R.rankInfoFor({ phone: '+1 610 555 0006', website: 'rotorooter.example' }, [list]);
check('a lead lower down shows ranks 1, 2, 3', foxtrot.my_rank === 5 && foxtrot.top3.map((t) => t.rank).join() === '1,2,3' && foxtrot.top3[0].phone === '+1 610-555-0001', foxtrot);
const echo = R.rankInfoFor({ business_name: 'Echo Drain Co', website: 'https://www.echo.example/?utm=1' }, [list]);
check('a lead with no phone is matched by its exact website page', echo && echo.my_rank === 4 && echo._by === 'website', echo);
check('a franchise page shared by two listings is not trusted for a website match', R.rankInfoFor({ website: 'https://rotorooter.example/' }, [list]) === null, 1);
check('a lead with a different phone is not matched by website', R.rankInfoFor({ phone: '(610) 555-7777', website: 'https://alpha.example/' }, [list]) === null, 1);
check('a lead that is not in the list gets null, nothing is guessed', R.rankInfoFor({ phone: '(215) 555-1212', website: 'https://nowhere.example' }, [list]) === null, 1);
check('the supply store is never matched as a lead', R.rankInfoFor({ phone: '(610) 555-0099' }, [list]) === null, 1);

// the same business in two searches: use the town it sits closest to
const near = R.toList(R.parseScrape(scrape([row('z1', 'Zulu Plumbing', '4.0', '(5)', 'Plumber', '+1 610-555-0010', '', 40.1, -75.3), row('z2', 'Other One', '4.0', '(5)', 'Plumber', '+1 610-555-0011', '', 40.1, -75.31)])), { query: 'plumber in Near PA', checked_at: '2026-11-25' });
const far = R.toList(R.parseScrape(scrape([row('y1', 'Yankee Plumbing', '4.0', '(5)', 'Plumber', '+1 610-555-0012', '', 39.5, -76.5), row('z1', 'Zulu Plumbing', '4.0', '(5)', 'Plumber', '+1 610-555-0010', '', 40.1, -75.3), row('y2', 'Yankee Two', '4.0', '(5)', 'Plumber', '+1 610-555-0013', '', 39.5, -76.5), row('y3', 'Yankee Three', '4.0', '(5)', 'Plumber', '+1 610-555-0014', '', 39.5, -76.5)])), { query: 'plumber in Far PA', checked_at: '2026-11-25' });
const zulu = R.rankInfoFor({ phone: '610-555-0010' }, [far, near]);
check('in two searches the lead gets the one centred nearest to it, not the best number', zulu.query === 'plumber in Near PA' && zulu.my_rank === 1, zulu);

(async () => {
  await ensureSchema();
  const t = new Date().toISOString();
  const add = (name, phone, site, ri) => db.run('INSERT INTO leads(business_name, phone, phone_norm, website, website_norm, source, created_at, updated_at, rank_info) VALUES(?,?,?,?,?,?,?,?,?::jsonb)', name, phone, Lib.normPhone(phone) || null, site, Lib.normWebsite(site) || null, 'google_maps', t, t, ri ? JSON.stringify(ri) : null);
  await add('Alpha Plumbing', '(610) 555-0001', 'https://alpha.example/');
  await add('Delta Heating & Plumbing', '+1 610-555-0004', '');
  await add('Echo Drain Co', '', 'https://echo.example/');
  await add('Nobody Plumbing', '(215) 555-1212', '');
  await add('Typed By Hand', '(610) 555-0006', '', { query: 'my own check', my_rank: 9, source: 'typed' });
  const lists = [list];

  const dry = await applyRankInfo({ lists, dryRun: true });
  check('apply: a dry run reports what it would do and writes nothing', dry.leads === 5 && dry.matched === 4 && dry.changes.length === 3 && dry.updated === 0 && (await db.get('SELECT COUNT(*) AS n FROM leads WHERE rank_info IS NOT NULL')).n === 1, dry);
  const run1 = await applyRankInfo({ lists, dryRun: false });
  check('apply: writes the three matches and keeps the hand-typed ranking from another source', run1.updated === 3 && run1.kept_other_source === 1 && run1.unchanged === 0, run1);
  const rows = Object.fromEntries((await db.all('SELECT business_name, rank_info, updated_at FROM leads')).map((x) => [x.business_name, x]));
  check('apply: the stored data is the rank_info shape (rank, total, top 3, query, source, date)', rows['Alpha Plumbing'].rank_info.my_rank === 1 && rows['Alpha Plumbing'].rank_info.total === 5 && rows['Alpha Plumbing'].rank_info.top3.length === 3 && rows['Alpha Plumbing'].rank_info.query === 'plumber in Testville PA' && rows['Alpha Plumbing'].rank_info.checked_at === '2026-11-25' && !('_by' in rows['Alpha Plumbing'].rank_info), rows['Alpha Plumbing'].rank_info);
  check('apply: matched by website and by phone, a lead not in any list stays empty', rows['Echo Drain Co'].rank_info.my_rank === 4 && rows['Delta Heating & Plumbing'].rank_info.my_rank === 3 && rows['Nobody Plumbing'].rank_info === null, 1);
  check('apply: the hand-typed ranking is untouched', rows['Typed By Hand'].rank_info.my_rank === 9 && rows['Typed By Hand'].rank_info.source === 'typed', rows['Typed By Hand'].rank_info);
  check('apply: nothing but rank_info changes (updated_at stays)', rows['Alpha Plumbing'].updated_at === t, rows['Alpha Plumbing'].updated_at);
  const run2 = await applyRankInfo({ lists, dryRun: false });
  check('apply: running it again changes nothing (idempotent)', run2.updated === 0 && run2.unchanged === 3 && run2.changes.length === 0, run2);
  const changed = [{ ...list, entries: list.entries.map((e) => (e.rank === 1 ? { ...e, name: 'Alpha Plumbing' } : e)), checked_at: '2026-12-01' }];
  const run3 = await applyRankInfo({ lists: changed, dryRun: false });
  check('apply: a newer scrape refreshes the ranking that came from the scrape source', run3.updated === 3 && (await db.get("SELECT rank_info->>'checked_at' AS d FROM leads WHERE business_name = 'Alpha Plumbing'")).d === '2026-12-01', run3);

  // the real files this was built from: structure only, so the test also guards a bad rebuild
  const file = path.join(__dirname, '..', 'scripts', 'rank-data', 'rank-lists.json');
  if (fs.existsSync(file)) {
    const real = JSON.parse(fs.readFileSync(file, 'utf8')).lists;
    check('rank-lists.json: three searches, each with consecutive ranks starting at 1 and a total that matches', real.length === 3 && real.every((l) => l.entries.every((e, i) => e.rank === i + 1) && l.total === l.entries.length && /^plumber in .+ PA$/.test(l.query)), real.map((l) => [l.query, l.total]));
    check('rank-lists.json: no business appears twice in one search', real.every((l) => new Set(l.entries.map((e) => e.name + '|' + e.phone_norm)).size === l.entries.length), 1);
  }
  await db.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
