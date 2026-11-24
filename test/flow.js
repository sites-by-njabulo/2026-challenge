'use strict';
/* End to end API test. Runs the app against an in-process Postgres (PGlite, a WebAssembly build of real Postgres),
   seeds it, and walks the whole flow over real HTTP. Nothing outside this process is touched.
   Run: node --no-warnings test/flow.js
   Also run it with TEST_VIA_PG=1 to go through the production database path (the pg package over a real Postgres connection). */
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PORT = 4399;
const BASE = 'http://127.0.0.1:' + PORT;
const PW = 'test-' + crypto.randomBytes(6).toString('hex');
const SETUP_TOKEN = 'setup-' + crypto.randomBytes(6).toString('hex');
const APP_SECRET = 'app-secret-' + crypto.randomBytes(16).toString('hex');
const CRON_SECRET = 'cron-secret-' + crypto.randomBytes(16).toString('hex');
// the same settings Vercel would hold as environment variables
delete process.env.DATABASE_URL;
Object.assign(process.env, { TEST_PGLITE: '1', APP_SECRET, SETUP_TOKEN, CRON_SECRET, ZAPMAIL_BASE: 'http://127.0.0.1:4397/api/v3' });
const Lib = require('../public/lib.js');
const { createServer, app } = require('../dev-server.js');
const { seed } = require('../seed.js');
const { resetSchemaFlag } = require('../src/schema.js');
const db = app.db;
let cookie = '';
const results = [];
function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); }

async function call(method, url, body, opts) {
  opts = opts || {};
  const res = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.noCookie ? {} : { Cookie: cookie }), ...(opts.headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length && !opts.keepCookie) { const m = /sid=([^;]*)/.exec(sc[0]); if (m) cookie = m[1] ? 'sid=' + m[1] : ''; }
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* binary or text */ }
  return { status: res.status, json, buf, headers: res.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readZip(buf) {
  const files = {};
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  const n = buf.readUInt16LE(i + 10), cdOff = buf.readUInt32LE(i + 16);
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lnLen = buf.readUInt16LE(off + 26), lxLen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnLen + lxLen, off + 30 + lnLen + lxLen + size);
    files[name] = { data, crcOk: (zlib.crc32(data) >>> 0) === crc };
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

let pgServer = null; // set when running through the production path (TEST_VIA_PG=1)

/* Everything the database holds, as text, for "is this secret anywhere in it" checks. */
async function wholeDatabaseText() {
  let out = '';
  const tables = (await db.all("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map((t) => t.tablename);
  for (const t of tables) out += JSON.stringify(await db.all('SELECT * FROM ' + t)) + '\n';
  const lite = db.raw().lite || (pgServer && pgServer.lite);
  const dump = await lite.dumpDataDir('none'); // the raw files of the database, like reading tracker.db used to
  out += Buffer.from(await dump.arrayBuffer()).toString('latin1');
  return out;
}

(async () => {
  if (process.env.TEST_VIA_PG === '1') {
    pgServer = await require('./pg-server.js').startPgServer(5439);
    delete process.env.TEST_PGLITE;
    process.env.DATABASE_URL = pgServer.url;
    process.env.DATABASE_SSL = 'off';
    console.log('Running through the production database path: pg package -> ' + pgServer.url.replace(/:[^:@]*@/, ':***@'));
  }
  // seed first, then start the server on the same database
  const seeded = await seed().catch((e) => ({ error: e.stack }));
  check('seed script runs', seeded.added === 10, seeded);
  check('the database engine is the one this run is meant to test (' + (pgServer ? 'pg, the production path' : 'PGlite') + ')', db.kind() === (pgServer ? 'pg' : 'pglite'), db.kind());
  await db.run("UPDATE leads SET status = 'contacted' WHERE business_name = 'Ridgeline Roofing'");
  resetSchemaFlag(); // like a fresh server instance starting: the tables check and the old-status fix run again
  const ZM_KEY = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  const mock = await require('./zapmail-mock.js').startMock(4397, ZM_KEY);
  const srv = createServer();
  await new Promise((resolve) => srv.listen(PORT, '127.0.0.1', resolve));
  // the Vercel entry file, served the way Vercel calls it: a plain (req, res) function
  const vercelStyle = require('node:http').createServer(require('../api/index.js'));
  await new Promise((resolve) => vercelStyle.listen(PORT + 10, '127.0.0.1', resolve));

  try {
    /* ---------- the Vercel function entry ---------- */
    const v1 = await fetch('http://127.0.0.1:' + (PORT + 10) + '/api/me');
    const v2 = await fetch('http://127.0.0.1:' + (PORT + 10) + '/index.html');
    check('api/index.js answers API calls as a plain (req, res) function, and only API calls', v1.status === 200 && (await v1.json()).setup_needed === true && v2.status === 404, [v1.status, v2.status]);

    /* ---------- auth ---------- */
    let r = await call('GET', '/api/me', null, { noCookie: true });
    check('first run asks to set a password', r.json && r.json.setup_needed === true && r.json.authenticated === false && r.json.setup_needs_code === true, r.json);
    r = await call('GET', '/api/leads', null, { noCookie: true });
    check('API is closed without a session', r.status === 401, r.status);
    r = await call('POST', '/api/setup', { password: PW }, { noCookie: true });
    check('first-run setup is refused without the setup code', r.status === 403 && !cookie, r.status);
    r = await call('POST', '/api/setup', { password: PW, setup_token: 'not-the-code' }, { noCookie: true });
    check('first-run setup is refused with a wrong setup code', r.status === 403 && !cookie, r.status);
    check('nothing was set by the refused attempts', (await call('GET', '/api/me', null, { noCookie: true })).json.setup_needed === true, 1);
    delete process.env.SETUP_TOKEN;
    r = await call('POST', '/api/setup', { password: PW, setup_token: SETUP_TOKEN }, { noCookie: true });
    process.env.SETUP_TOKEN = SETUP_TOKEN;
    check('if SETUP_TOKEN is not configured on the server, setup is refused outright', r.status === 503, r.status);
    r = await call('POST', '/api/setup', { password: 'short', setup_token: SETUP_TOKEN }, { noCookie: true });
    check('short password rejected', r.status === 400, r.status);
    r = await call('POST', '/api/setup', { password: PW, setup_token: SETUP_TOKEN }, { noCookie: true });
    check('password set and signed in', r.status === 200 && cookie.startsWith('sid='), r.status);
    r = await call('POST', '/api/setup', { password: 'another-password-1', setup_token: SETUP_TOKEN }, { noCookie: true });
    check('once a password exists the setup path is closed, even with the right code', r.status === 409, r.status);
    check('the password is stored hashed, never as typed', !(await wholeDatabaseText()).includes(PW), 1);
    r = await call('POST', '/api/leads', { business_name: 'Evil' }, { headers: { Origin: 'http://evil.example' } });
    check('cross-site POST is refused', r.status === 403, r.status);
    r = await call('GET', '/../server.js', null, { noCookie: true });
    check('static path traversal is refused', r.status === 403 || r.status === 404, r.status);

    /* ---------- seeded data ---------- */
    r = await call('GET', '/api/leads?limit=50');
    check('10 demo leads are present', r.json.total === 10, r.json && r.json.total);
    const ridge = r.json.rows.find((x) => x.business_name === 'Ridgeline Roofing');
    check('old "contacted" leads were moved to Follow up when the server started', ridge && ridge.status === 'follow_up', ridge && ridge.status);
    r = await call('PATCH', `/api/leads/${ridge.id}`, { status: 'contacted' });
    check('the removed status "contacted" is refused', r.status === 400, r.status);
    check('state gives a time zone (TN = Central)', ridge && ridge.tz === 'America/Chicago', ridge && ridge.tz);

    /* ---------- add + duplicate detection ---------- */
    r = await call('POST', '/api/leads', { business_name: 'Totally New Name', phone: '1-615-555-0142', city: 'Elsewhere' });
    check('same phone (different format) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same phone'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Other Name', website: 'https://www.RidgelineRoofing.example/about/', city: 'X' });
    check('same website (www, path, case) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same website'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Ridgeline Roofing LLC', city: 'nashville' });
    check('same name plus city (LLC ignored) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same name and city'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Ridgeline Roofing', city: 'Memphis', phone: '(901) 555-0100' });
    check('same name in a different city is NOT a duplicate', r.status === 200, r.status);
    const memphisId = r.json.lead.id;
    r = await call('POST', '/api/leads', { business_name: 'Totally New Name', phone: '(615) 555-0142', city: 'Elsewhere', force: true });
    check('add anyway works after the warning', r.status === 200, r.status);
    r = await call('POST', '/api/leads', {});
    check('business name is required', r.status === 400, r.status);

    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', owner_name: 'Gus', phone: '(615) 555-0001', city: 'Nashville', state: 'TN', trade: 'Roofer', source: 'Google Maps', source_link: 'https://maps.example/maple', batch: 'Flow test' });
    check('new lead saved with source and link recorded', r.status === 200 && r.json.lead.source === 'google_maps' && r.json.lead.source_link, r.json);
    const maple = r.json.lead.id;
    check('new lead starts as New with no follow-up', r.json.lead.status === 'new' && !r.json.lead.next_followup, r.json.lead);

    /* ---------- contact log on two+ channels ---------- */
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'sent' });
    check('outcome that does not belong to the channel is refused', r.status === 400, r.status);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'no_answer', content: 'Rang out' });
    check('call logged, status becomes Follow up', r.status === 200 && r.json.lead.status === 'follow_up', r.json);
    check('automatic follow-up lands on a working day', r.json.followup && ![0, 6].includes(new Date(r.json.followup + 'T12:00:00Z').getUTCDay()), r.json.followup);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'instagram_dm', outcome: 'sent', content: 'Opener' });
    check('Instagram DM logged on the same lead', r.status === 200, r.status);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'facebook_dm', outcome: 'replied', content: 'Yes send it' });
    check('reply moves status to Replied', r.json.lead.status === 'replied', r.json.lead.status);
    r = await call('GET', `/api/leads/${maple}`);
    check('one lead, three entries on its timeline', r.json.contacts.length === 3 && new Set(r.json.contacts.map((c) => c.channel)).size === 3, r.json.contacts.length);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'not_interested' });
    check('Not interested closes the follow-up', r.json.lead.status === 'not_interested' && r.json.lead.next_followup === null, r.json.lead);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'no_answer' });
    check('a later no-answer does not revive a Not interested lead', r.json.lead.status === 'not_interested', r.json.lead.status);
    r = await call('PATCH', `/api/leads/${maple}`, { status: 'follow_up', next_followup: new Date().toISOString().slice(0, 10) });
    check('status and follow-up can be set by hand', r.json.lead.status === 'follow_up', r.json.lead);
    const today = (await call('GET', '/api/today')).json;
    check('lead due today appears in Follow up today', today.followups.some((x) => x.id === maple), today.followups.map((x) => x.id));
    const fuAll = (await call('GET', '/api/followups?scope=due')).json;
    const by = today.followups_by || {};
    check('/api/today returns followups_by with one count per channel group', ['call', 'dm', 'email', 'text'].every((g) => Number.isInteger(by[g]) && by[g] >= 0), by);
    check('followups_by matches the Follow-ups page counts and never exceeds the total due', ['call', 'dm', 'email', 'text'].every((g) => by[g] === fuAll.counts[g]) && today.followups_total === fuAll.counts.all && Object.values(by).reduce((n, v) => n + v, 0) <= today.followups_total, [by, today.followups_total, fuAll.counts]);
    check('today progress counts the calls just logged', today.progress.calls >= 2 && today.progress.dms >= 1, today.progress);

    /* ---------- opt out ---------- */
    r = await call('POST', `/api/leads/${maple}/optout`, { channel: 'instagram_dm', note: 'Asked to stop in a DM' });
    check('opt-out recorded with date and channel', r.status === 200 && r.json.lead.opted_out === true && r.json.lead.opt_out_channel === 'instagram_dm' && r.json.lead.opt_out_date, r.json.lead);
    check('opt-out is stored as its own record', r.json.optouts.length === 1 && r.json.optouts[0].note, r.json.optouts);
    check('opt-out clears the follow-up', r.json.lead.next_followup === null, r.json.lead.next_followup);
    let t2 = (await call('GET', '/api/today?follow_limit=200')).json;
    const c2 = (await call('GET', '/api/calls?ready_limit=400')).json.queue;
    check('opted-out lead leaves the follow-up list', !t2.followups.some((x) => x.id === maple), 1);
    check('opted-out lead leaves the call queue', ![...c2.ready, ...c2.later, ...c2.no_tz].some((x) => x.id === maple), 1);
    for (const ch of ['call', 'email', 'facebook_dm']) {
      r = await call('POST', `/api/leads/${maple}/contacts`, { channel: ch, outcome: ch === 'call' ? 'no_answer' : 'sent' });
      check('logging on ' + ch + ' is blocked for an opted-out lead', r.status === 409, r.status);
    }
    r = await call('PATCH', `/api/leads/${maple}`, { next_followup: '2030-01-01', opted_out: 0 });
    check('cannot sneak a follow-up or un-opt-out through an edit', r.json.lead.opted_out === true && r.json.lead.next_followup === null, r.json.lead);
    r = await call('POST', `/api/leads/${maple}/optout/remove`, { confirm: 'yes' });
    check('removing an opt-out needs the typed confirmation', r.status === 400, r.status);
    r = await call('DELETE', `/api/leads/${maple}?confirm=1`);
    check('deleting an opted-out lead needs its name typed', r.status === 400, r.status);
    r = await call('DELETE', `/api/leads/${maple}?confirm=` + encodeURIComponent('Maple Street Roofing'));
    check('deleting with the typed name works', r.status === 200, r.status);
    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', phone: '(615) 555-0001', city: 'Nashville' });
    check('the deleted opt-out still blocks a re-add (warning)', r.status === 409 && r.json.optouts.length === 1, r.json);
    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', phone: '(615) 555-0001', city: 'Nashville', force: true });
    check('forced re-add is saved as opted out, not contactable', r.status === 200 && r.json.lead.opted_out === true && r.json.flagged_optout === true, r.json.lead);
    const mapleBack = r.json.lead.id;
    r = await call('POST', `/api/leads/${mapleBack}/optout/remove`, { confirm: 'REMOVE', note: 'They asked to hear from me' });
    check('opt-out can be removed with REMOVE, history kept', r.status === 200 && r.json.lead.opted_out === false && r.json.optouts.some((o) => o.removed_at), r.json.optouts);

    /* ---------- CSV import with a duplicate ---------- */
    const rows = [
      { business_name: 'Import One Plumbing', phone: '(404) 555-0201', city: 'Atlanta', state: 'Georgia', trade: 'Plumber', owner_name: 'Ana' },
      { business_name: 'Copperfield Plumbing', phone: '303.555.0118', city: 'Denver', state: 'CO', email: 'fill@copperfield.example' },
      { business_name: 'Import One Plumbing', phone: '(404) 555-0201', city: 'Atlanta', state: 'GA' },
      { business_name: 'Prairie State Roofing', phone: '(217) 555-0126', city: 'Springfield', state: 'IL' },
      { business_name: '', phone: '(404) 555-0999' },
      { business_name: 'Import Two HVAC', phone: '(404) 555-0202', city: 'Atlanta', state: 'GA', trade: 'HVAC', source: 'Instagram' },
    ];
    r = await call('POST', '/api/import/preview', { rows, defaults: { source: 'google_maps', source_link: 'file: demo.csv', batch: 'Import test' } });
    const c = r.json.counts;
    check('preview: 2 new, 1 duplicate, 1 repeat in file, 1 opted-out match, 1 invalid', c.new === 2 && c.dup === 1 && c.dup_in_file === 1 && c.optout === 1 && c.invalid === 1, c);
    check('preview names the lead each duplicate matches', r.json.rows[1].matches[0].business_name === 'Copperfield Plumbing', r.json.rows[1].matches);
    r = await call('GET', '/api/leads?limit=100');
    const before = r.json.total;
    r = await call('POST', '/api/import/commit', { rows, defaults: { source: 'google_maps', source_link: 'file: demo.csv', batch: 'Import test' }, mode: 'skip' });
    check('commit (skip): adds the 2 new, skips duplicates, blocks the opt-out', r.json.added === 2 && r.json.skipped_duplicates === 2 && r.json.blocked_optout === 1 && r.json.invalid === 1, r.json);
    r = await call('GET', '/api/leads?limit=100');
    check('lead count grew by exactly 2', r.json.total === before + 2, [before, r.json.total]);
    const imported = r.json.rows.find((x) => x.business_name === 'Import One Plumbing');
    check('import recorded source link, batch and normalised the state name', imported && imported.source_link === 'file: demo.csv' && imported.batch === 'Import test' && imported.state === 'GA', imported);
    const ig = r.json.rows.find((x) => x.business_name === 'Import Two HVAC');
    check('a source column in the file beats the default', ig && ig.source === 'instagram', ig && ig.source);
    r = await call('POST', '/api/import/commit', { rows, defaults: { source: 'google_maps' }, mode: 'update' });
    const rid = (await call('GET', '/api/leads?q=Copperfield&limit=10')).json.rows[0];
    check('commit (update): fills the blank email on the existing lead', r.json.updated === 1 && rid.email === 'fill@copperfield.example', [r.json, rid.email]);
    const rdg = (await call('GET', '/api/leads?q=Ridgeline&limit=10')).json.rows.find((x) => x.city === 'Nashville');
    check('commit (update): never overwrites a field that already has a value', rdg.email === 'dale@ridgelineroofing.example', rdg.email);
    const totalBefore = (await call('GET', '/api/leads?limit=1')).json.total;
    r = await call('POST', '/api/import/commit', { rows: [rows[0]], defaults: { source: 'google_maps' }, mode: 'add' });
    check('commit (add anyway): duplicate becomes a new lead', r.json.added === 1 && (await call('GET', '/api/leads?limit=1')).json.total === totalBefore + 1, r.json);

    /* ---------- call queue and the legal calling window ---------- */
    const zones = [['Eastern', 'NY'], ['Central', 'TX'], ['Mountain', 'CO'], ['Arizona', 'AZ'], ['Pacific', 'CA'], ['Alaska', 'AK'], ['Hawaii', 'HI']];
    let n = 0;
    for (const [z, st] of zones) { n++; await call('POST', '/api/leads', { business_name: 'TZ ' + z, phone: '(555) 010-' + String(n).padStart(4, '0'), city: 'Town ' + z, state: st }); }
    await call('POST', '/api/leads', { business_name: 'TZ Unknown', phone: '(555) 010-0099', city: 'Nowhere' });
    const allQ = (t) => [...t.queue.ready, ...t.queue.later, ...t.queue.no_tz];
    const q = async (iso) => { const t = (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(iso))).json; return Object.fromEntries(allQ(t).filter((x) => x.business_name.startsWith('TZ ')).map((x) => [x.business_name.slice(3), x.window])); };
    let w = await q('2026-11-24T14:00:00Z');    // 9:00 ET, 8:00 CT, 7:00 MT, 7:00 AZ, 6:00 PT, 5:00 AK, 4:00 HI
    check('14:00Z: Eastern and Central can be called', w.Eastern.ok && w.Central.ok, [w.Eastern, w.Central]);
    check('14:00Z: Mountain, Arizona, Pacific, Alaska, Hawaii are still closed', !w.Mountain.ok && !w.Arizona.ok && !w.Pacific.ok && !w.Alaska.ok && !w.Hawaii.ok, w);
    w = await q('2026-11-25T03:30:00Z');         // 22:30 ET, 21:30 CT, 20:30 MT, 20:30 AZ, 19:30 PT, 18:30 AK, 17:30 HI
    check('03:30Z: Eastern and Central are closed for the night', !w.Eastern.ok && !w.Central.ok, [w.Eastern, w.Central]);
    check('03:30Z: Mountain, Arizona, Pacific, Alaska, Hawaii are open', w.Mountain.ok && w.Arizona.ok && w.Pacific.ok && w.Alaska.ok && w.Hawaii.ok, w);
    w = await q('2026-11-24T13:00:00Z');         // exactly 8:00 ET
    check('exactly 8:00 AM local is open', w.Eastern.ok === true, w.Eastern);
    w = await q('2026-11-24T12:59:00Z');
    check('7:59 AM local is closed and says when it opens', w.Eastern.ok === false && w.Eastern.minsUntilOpen === 1, w.Eastern);
    w = await q('2026-11-25T01:59:00Z');         // 20:59 ET
    check('8:59 PM local is still open', w.Eastern.ok === true && w.Eastern.minsLeft === 1, w.Eastern);
    w = await q('2026-11-25T02:00:00Z');         // 21:00 ET
    check('exactly 9:00 PM local is closed', w.Eastern.ok === false, w.Eastern);
    w = await q('2026-07-15T13:00:00Z');         // summer: 9:00 EDT, 6:00 AZ (no daylight saving)
    check('summer time: Eastern open (EDT), Arizona still closed (no DST)', w.Eastern.ok && !w.Arizona.ok, [w.Eastern, w.Arizona]);
    check('lead with no state or zone is flagged, never OK to call', w.Unknown && w.Unknown.unknown === true && w.Unknown.ok === false, w.Unknown);
    const tq = (await call('GET', '/api/calls?ready_limit=400&now=2026-11-24T14:00:00Z')).json;
    check('the ready list holds only callable leads', tq.queue.ready.length > 0 && tq.queue.ready.every((x) => x.window.ok) && tq.queue.later.every((x) => !x.window.ok), [tq.queue.ready_total, tq.queue.later_total]);
    check('leads without a time zone are listed separately', tq.queue.no_tz.some((x) => x.business_name === 'TZ Unknown'), tq.queue.no_tz.length);
    const calledLead = tq.queue.ready.find((x) => x.business_name === 'TZ Eastern');
    r = await call('POST', `/api/leads/${calledLead.id}/contacts`, { channel: 'call', outcome: 'voicemail' });
    const tq2 = (await call('GET', '/api/calls?ready_limit=400')).json;
    check('after logging a call the lead leaves today\'s queue (follow-up is set)', !allQ(tq2).some((x) => x.id === calledLead.id), 1);

    /* ---------- follow-ups page: many leads ---------- */
    const todayKey = (await call('GET', '/api/today')).json.progress.today;
    const ids60 = [];
    for (let i = 0; i < 60; i++) {
      const created = await call('POST', '/api/leads', { business_name: 'Follow Co ' + i, phone: '(555) 88' + String(i).padStart(2, '0') + '-' + String(2000 + i), city: 'Followville', state: 'OH', source: 'instagram' });
      ids60.push(created.json.lead.id);
      await call('PATCH', '/api/leads/' + created.json.lead.id, { next_followup: todayKey });
    }
    for (let i = 0; i < 10; i++) { await call('POST', '/api/leads/' + ids60[i] + '/contacts', { channel: 'instagram_dm', outcome: 'sent', followup: todayKey }); }
    for (let i = 10; i < 15; i++) { await call('POST', '/api/leads/' + ids60[i] + '/contacts', { channel: 'call', outcome: 'no_answer', followup: todayKey }); }
    const soonLead = (await call('POST', '/api/leads', { business_name: 'Soon Co', phone: '(555) 889-0001', city: 'Soonville', state: 'OH' })).json.lead.id;
    await call('PATCH', '/api/leads/' + soonLead, { next_followup: Lib.addBizDays(todayKey, 3) });
    let fu = (await call('GET', '/api/followups?limit=50')).json;
    check('follow-ups page: counts every lead that is due, not just a few', fu.total >= 60 && fu.rows.length === 50, [fu.total, fu.rows.length]);
    const fu2 = (await call('GET', '/api/followups?limit=50&offset=50')).json;
    check('follow-ups page: the rest come on the next page, no repeats', fu2.rows.length === fu.total - 50 && !fu2.rows.some((x) => fu.rows.some((y) => y.id === x.id)), [fu2.rows.length, fu.total]);
    check('follow-ups: counts by channel (10 DMs, 5 calls)', fu.counts.dm >= 10 && fu.counts.call >= 5 && fu.counts.all === fu.total, fu.counts);
    fu = (await call('GET', '/api/followups?channel=dm&limit=200')).json;
    check('follow-ups: the DM filter shows only leads last contacted by DM', fu.rows.length === fu.counts.dm && fu.rows.every((x) => ['instagram_dm', 'facebook_dm', 'facebook_group'].includes(x.last_channel)), [fu.rows.length, fu.counts]);
    const soonList = (await call('GET', '/api/followups?scope=soon&limit=200')).json;
    check('follow-ups: coming up lists the lead due in 3 days, due-now does not', soonList.rows.some((x) => x.id === soonLead) && !(await call('GET', '/api/followups?limit=200')).json.rows.some((x) => x.id === soonLead), soonList.total);
    const tdy = (await call('GET', '/api/today')).json;
    check('Today shows the true count but only a short preview', tdy.followups_total === (await call('GET', '/api/followups?limit=1')).json.total && tdy.followups.length <= 8 && tdy.followups_total > 8, [tdy.followups_total, tdy.followups.length]);

    /* ---------- calls page: numbers and scoreboard ---------- */
    const cs0 = (await call('GET', '/api/calls?period=today')).json;
    check('calls: totals include contacts reached, owner conversations, good conversations and the rates', ['dials', 'reached', 'owner', 'good', 'meetings', 'pickup_rate', 'owner_rate', 'booking_rate'].every((k) => k in cs0.totals) && cs0.outcomes.length === 7, cs0.totals);
    const day0 = (await call('GET', '/api/calls/day')).json;
    check('scoreboard: today has auto counts, adjustments and totals', day0.is_today && day0.totals.calls === day0.auto.calls + day0.adj.calls && 'reached' in day0.totals && 'good' in day0.totals, day0);
    let day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'calls', value: day0.totals.calls + 30 })).json;
    check('scoreboard: + works, the counter shows what you set', day1.totals.calls === day0.totals.calls + 30 && day1.adj.calls === day0.adj.calls + 30, day1);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'good', value: 4 })).json;
    check('scoreboard: each of the four counters can be set', day1.totals.good === 4 && day1.totals.calls === day0.totals.calls + 30, day1.totals);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'owner', value: -5 })).json;
    check('scoreboard: a counter never goes below zero', day1.totals.owner === 0, day1.totals);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, verdict: 'Good day. Hooks worked, mornings are quiet.' })).json;
    check('scoreboard: the verdict of the day is saved', day1.verdict.startsWith('Good day') && (await call('GET', '/api/calls/day?day=' + day0.day)).json.verdict === day1.verdict, day1.verdict);
    const tomorrow = Lib.addDaysKey(day0.day, 1);
    check('scoreboard: a day that has not happened yet is refused', (await call('PUT', '/api/calls/day', { day: tomorrow, field: 'calls', value: 3 })).status === 400, 1);
    check('scoreboard: an unknown counter is refused', (await call('PUT', '/api/calls/day', { day: day0.day, field: 'nope', value: 3 })).status === 400, 1);
    const cs1 = (await call('GET', '/api/calls?period=today')).json;
    check('calls: your + changes feed the totals and rates', cs1.totals.dials === day1.totals.calls && cs1.totals.good === 4 && Math.abs(cs1.totals.pickup_rate - cs1.totals.reached / cs1.totals.dials) < 1e-9 && cs1.adjusted_days >= 1, cs1.totals);
    check('calls: the dials meter on the queue and on Today agree', cs1.dials_today === day1.totals.calls && (await call('GET', '/api/today')).json.progress.calls === day1.totals.calls, [cs1.dials_today, day1.totals.calls]);
    const hist = (await call('GET', '/api/calls/history')).json;
    check('scoreboard: last days with averages, today included', hist.days.length >= 1 && hist.days[0].day === day0.day && hist.averages && hist.averages.calls > 0 && hist.days.length <= 7, hist);
    check('calls: week and 30-day periods work, 14 days of history, best hours', (await call('GET', '/api/calls?period=week')).json.totals.dials >= cs1.totals.dials && (await call('GET', '/api/calls?period=month')).json.totals.dials >= cs1.totals.dials && cs1.daily.length === 14 && Array.isArray(cs1.by_hour), 1);

    /* ---------- reached out today: calls, Instagram, Facebook, email ---------- */
    let out0 = (await call('GET', '/api/outreach/day')).json;
    check('reached out: four counters and one total', out0.items.map((i) => i.key).join(',') === 'call,instagram_dm,facebook_dm,email' && out0.total === out0.items.reduce((n, i) => n + i.total, 0), out0);
    check('reached out: the call counter matches the calls scoreboard', out0.items[0].total === day1.totals.calls, out0.items[0]);
    let out1 = (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'instagram_dm', value: out0.items[1].total + 9 })).json;
    check('reached out: + on Instagram DMs adds to the total', out1.items[1].total === out0.items[1].total + 9 && out1.total === out0.total + 9, out1);
    out1 = (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'facebook_dm', value: 6 })).json;
    check('reached out: Facebook DMs are tracked too', out1.items[2].total === 6 && out1.total === out0.total + 9 + (6 - out0.items[2].total), out1);
    const fbLead = (await call('POST', '/api/leads', { business_name: 'Counter Test Co', phone: '(555) 886-0001', city: 'Counterville', state: 'KY' })).json.lead.id;
    await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'facebook_dm', outcome: 'sent' });
    await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'facebook_dm', outcome: 'replied' });
    const out2 = (await call('GET', '/api/outreach/day')).json;
    check('reached out: a DM logged as Sent counts by itself, a reply does not', out2.items[2].total === 7 && out2.items[2].auto === out1.items[2].auto + 1, out2.items[2]);
    check('reached out: emails count when logged as Sent', (await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'email', outcome: 'sent', mailbox: 'jay@example.test' })).status === 200 && (await call('GET', '/api/outreach/day')).json.items[3].total === out2.items[3].total + 1, 1);
    const t3 = (await call('GET', '/api/today')).json;
    check('Today: the dms progress is Instagram plus Facebook, and the outreach block is included', t3.progress.dms === t3.outreach.items[1].total + t3.outreach.items[2].total && t3.outreach.total >= 30, [t3.progress, t3.outreach.total]);
    check('reached out: unknown counter and future day are refused', (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'nope', value: 1 })).status === 400 && (await call('PUT', '/api/outreach/day', { day: tomorrow, key: 'email', value: 1 })).status === 400, 1);

    /* ---------- contacted via + mailbox on emails ---------- */
    const via = (await call('GET', '/api/leads?q=Counter Test')).json.rows[0];
    check('leads list: shows every channel used, with counts', via.channels.some((c) => c.channel === 'facebook_dm' && c.count === 2) && via.channels.some((c) => c.channel === 'email' && c.count === 1), via.channels);
    check('leads list: filter by "contacted via" Email', (await call('GET', '/api/leads?channel=email&limit=500')).json.rows.every((x) => x.channels.some((c) => c.channel === 'email')) && (await call('GET', '/api/leads?channel=email&limit=500')).json.rows.some((x) => x.id === via.id), 1);
    const never = (await call('GET', '/api/leads?channel=none&limit=500')).json;
    check('leads list: filter "not contacted yet" returns only untouched leads', never.rows.length > 0 && never.rows.every((x) => x.channels.length === 0), never.total);
    const withBox = (await call('GET', '/api/leads/' + via.id)).json.contacts.find((c) => c.channel === 'email');
    check('an email entry remembers which mailbox sent it', withBox && withBox.mailbox === 'jay@example.test', withBox);
    await call('POST', '/api/leads/' + via.id + '/contacts', { channel: 'call', outcome: 'no_answer', mailbox: 'jay@example.test' });
    check('a mailbox is only kept on emails', (await call('GET', '/api/leads/' + via.id)).json.contacts.filter((c) => c.channel === 'call').every((c) => c.mailbox === null), 1);

    /* ---------- Zapmail snapshot, warm-up dates, cold email numbers ---------- */
    const mk = (score) => ({ taken_at: '2026-11-24T10:00:00Z', source: 'test', plan: { name: 'Starter' }, zapwarm: { started: '2026-11-23', daily_emails: 5, free_trial_ends: '2026-12-23' },
      domains: [{ name: 'example.test', status: 'connected' }], mailboxes: [{ email: 'jay@example.test', domain: 'example.test', status: 'Warming up', score, score_max: 5 }, { email: 'hello@example.test', domain: 'example.test', status: 'Warming up', score, score_max: 5 }] });
    check('email page before any snapshot says nothing is connected', (await call('GET', '/api/email')).json.snapshot === null, 1);
    check('a snapshot without mailboxes is refused', (await call('POST', '/api/email/snapshot', { zapwarm: {} })).status === 400, 1);
    check('a Zapmail snapshot is saved', (await call('POST', '/api/email/snapshot', mk(1))).status === 200, 1);
    let em = (await call('GET', '/api/email?now=2026-11-24T11:00:00Z')).json;
    check('email: warm-up day, earliest send date and safer date are worked out', em.readiness.day === 2 && em.readiness.ready_from === '2026-12-14' && em.readiness.ready_by === '2026-12-21' && em.readiness.ready_now === false && em.readiness.days_to_ready === 20, em.readiness);
    check('email: a snapshot a few hours old is not stale', em.stale === false && em.synced_hours_ago === 1, [em.stale, em.synced_hours_ago]);
    check('email: a snapshot older than a day is flagged out of date', (await call('GET', '/api/email?now=2026-11-26T11:00:00Z')).json.stale === true, 1);
    check('email: ready once the 21 days are done', (await call('GET', '/api/email?now=2026-12-15T11:00:00Z')).json.readiness.ready_now === true, 1);
    check('email: cold sends today are counted per mailbox against the cap', em.per_mailbox_limit === 5 && em.capacity_today === 10, [em.per_mailbox_limit, em.capacity_today]);
    check('email: cold email totals come from the log', em.cold.sent_total >= 1 && 'reply_rate' in em.cold, em.cold);
    await call('PUT', '/api/settings', { email_daily_per_mailbox: 3 });
    check('email: the per-mailbox cap can be changed', (await call('GET', '/api/email')).json.capacity_today === 6, 1);
    await call('POST', '/api/email/snapshot', mk(3));
    em = (await call('GET', '/api/email')).json;
    check('email: score trend compares with the snapshot before', em.score_before === 1 && em.score_now === 3, [em.score_before, em.score_now]);
    check('email: the pre-send checklist is saved', (await call('PUT', '/api/settings', { email_checklist: JSON.stringify(['address', 'optout']) })).status === 200 && (await call('GET', '/api/email')).json.checked.join() === 'address,optout' && (await call('PUT', '/api/settings', { email_checklist: 'nope' })).status === 400, 1);

    /* ---------- Zapmail API connection (against a pretend Zapmail) ---------- */
    check('zapmail: starts disconnected', (await call('GET', '/api/zapmail/status')).json.connected === false, 1);
    check('zapmail: something that is not a key is refused before any call', (await call('PUT', '/api/zapmail/key', { key: 'not-a-key' })).status === 400 && mock.calls.length === 0, mock.calls.length);
    r = await call('PUT', '/api/zapmail/key', { key: '00000000-0000-4000-8000-000000000000' });
    check('zapmail: a wrong key is rejected with a plain message and is not kept', r.status === 400 && /rejected the key/.test(r.json.error) && (await call('GET', '/api/zapmail/status')).json.connected === false, r.json);
    const beforeSnap = (await call('GET', '/api/email')).json.snapshot;
    r = await call('PUT', '/api/zapmail/key', { key: ZM_KEY });
    check('zapmail: the right key connects and reads the mailboxes', r.status === 200 && r.json.connected === true && r.json.mailboxes === 3 && r.json.key_hint === ZM_KEY.slice(-4), r.json);
    const okCalls = mock.calls.filter((c) => c.auth === ZM_KEY);
    check('zapmail: only the three read calls were made, always with the key header', okCalls.length >= 3 && okCalls.every((c) => c.method === 'POST' && ['/api/v3/mailboxes/list', '/api/v3/domains', '/api/v3/zap-warm/scores'].includes(c.path)) && !mock.calls.some((c) => c.method !== 'POST'), mock.calls.map((c) => c.method + ' ' + c.path));
    let zem = (await call('GET', '/api/email')).json;
    check('zapmail: the Email page now comes from the API', /Zapmail API/.test(zem.snapshot.source) && zem.snapshot.mailboxes.length === 3, zem.snapshot.source);
    const m1 = zem.snapshot.mailboxes.find((m) => m.email === 'jay@mock-one.test');
    const m3 = zem.snapshot.mailboxes.find((m) => m.email === 'jay@mock-two.test');
    check('zapmail: score, sent count and inbox rate come through; unscored mailbox shows Active', m1.score === 60 && m1.score_max === 100 && m1.sent_30d === 12 && m1.inbox_rate === 1 && m1.status === 'Warming up' && m3.score === null && m3.status === 'Active', [m1, m3]);
    check('zapmail: warm-up start date and totals are worked out', zem.snapshot.zapwarm.started === '2026-11-23' && zem.snapshot.zapwarm.emails_sent_30d === 20 && Math.abs(zem.snapshot.zapwarm.inbox_rate - 19 / 20) < 1e-9 && zem.readiness.day >= 2, zem.snapshot.zapwarm);
    check('zapmail: domains show connected only when the nameservers match', zem.snapshot.domains.find((d) => d.name === 'mock-one.test').status === 'connected' && zem.snapshot.domains.find((d) => d.name === 'mock-two.test').status !== 'connected', zem.snapshot.domains);
    check('zapmail: plan, trial dates and warm-up settings are carried over from the last snapshot', zem.snapshot.plan.name === 'Starter' && zem.snapshot.zapwarm.free_trial_ends === '2026-12-23' && zem.snapshot.zapwarm.daily_emails === 5, [zem.snapshot.plan, zem.snapshot.zapwarm]);
    const wholePage = JSON.stringify(zem) + JSON.stringify((await call('GET', '/api/zapmail/status')).json) + JSON.stringify((await call('GET', '/api/settings')).json);
    check('zapmail: no password, app password, 2FA secret or key appears in anything the app returns', !/SECRET(PW|APP|2FA)/.test(wholePage) && !wholePage.includes(ZM_KEY) && !wholePage.includes('x-auth'), 1);
    const dbBytes = await wholeDatabaseText();
    check('zapmail: the database holds no mailbox password or 2FA secret', !/SECRETPW|SECRETAPP|SECRET2FA/.test(dbBytes), 1);
    check('zapmail: the key is stored encrypted, not as plain text', !dbBytes.includes(ZM_KEY) && !dbBytes.includes(Buffer.from(ZM_KEY).toString('base64')), 1);
    const encRow = (await db.get("SELECT value FROM settings WHERE key = 'zapmail_key_enc'")).value;
    check('zapmail: the stored text is AES-GCM (12 byte nonce + 16 byte tag + the key), made with APP_SECRET', Buffer.from(encRow, 'base64').length === 12 + 16 + ZM_KEY.length, encRow.length);
    const zipNow = (await call('GET', '/api/export/all.zip')).buf.toString('latin1');
    check('zapmail: the export zip does not contain the key either', !zipNow.includes(ZM_KEY) && !/SECRETPW|SECRETAPP|SECRET2FA/.test(zipNow), 1);
    process.env.APP_SECRET = 'a-completely-different-secret-1234567890';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: with a different APP_SECRET the saved key cannot be opened, and the message says what to do', r.status === 409 && /APP_SECRET/.test(r.json.error) && /paste the key again/.test(r.json.error), r.json);
    process.env.APP_SECRET = APP_SECRET;
    check('zapmail: with the right APP_SECRET it opens again', (await call('POST', '/api/zapmail/sync')).status === 200, 1);
    delete process.env.APP_SECRET;
    r = await call('PUT', '/api/zapmail/key', { key: ZM_KEY });
    check('zapmail: with no APP_SECRET on the server a key is refused, not stored in the clear', r.status === 503 && /APP_SECRET/.test(r.json.error), r.json);
    process.env.APP_SECRET = APP_SECRET;
    const priorCount = (await call('GET', '/api/email')).json.snapshot.mailboxes.length;
    mock.state.mode = 'not_enabled';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: "API not enabled" gives a clear message and keeps the last numbers', r.status === 502 && /not switched on/.test(r.json.error) && (await call('GET', '/api/email')).json.snapshot.mailboxes.length === priorCount && /not switched on/.test((await call('GET', '/api/zapmail/status')).json.last_error), r.json);
    mock.state.mode = 'rate';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: being rate limited gives a plain message', r.status === 502 && /limiting/.test(r.json.error), r.json);
    mock.state.mode = 'ok';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: Refresh now works again and clears the error', r.status === 200 && (await call('GET', '/api/zapmail/status')).json.last_error === null, r.json);
    check('zapmail: each sync adds a snapshot, so score history builds', (await call('GET', '/api/email')).json.score_before != null, 1);

    /* ---------- the once-a-day Vercel cron ---------- */
    r = await call('GET', '/api/cron/zapmail', null, { noCookie: true });
    check('cron: no secret, no entry (401)', r.status === 401, r.status);
    r = await call('GET', '/api/cron/zapmail', null, { noCookie: true, headers: { Authorization: 'Bearer wrong-secret-wrong-secret' } });
    check('cron: a wrong secret is refused (401)', r.status === 401, r.status);
    r = await call('GET', '/api/cron/zapmail', null, { headers: { Authorization: 'Bearer ' + SETUP_TOKEN } });
    check('cron: the setup code or a login cookie does not open it, only CRON_SECRET', r.status === 401, r.status);
    const snapsBefore = (await db.get('SELECT COUNT(*) AS n FROM email_snapshots')).n;
    r = await call('GET', '/api/cron/zapmail', null, { noCookie: true, headers: { Authorization: 'Bearer ' + CRON_SECRET } });
    check('cron: with CRON_SECRET it refreshes Zapmail and adds a snapshot', r.status === 200 && r.json.synced === true && r.json.mailboxes === 3 && (await db.get('SELECT COUNT(*) AS n FROM email_snapshots')).n === Math.min(60, snapsBefore + 1), [r.status, r.json]);
    delete process.env.CRON_SECRET;
    r = await call('GET', '/api/cron/zapmail', null, { noCookie: true, headers: { Authorization: 'Bearer ' } });
    check('cron: with no CRON_SECRET configured the route stays shut', r.status === 503, r.status);
    process.env.CRON_SECRET = CRON_SECRET;
    r = await call('DELETE', '/api/zapmail/key');
    check('zapmail: disconnecting deletes the key', r.json.connected === false && (await call('POST', '/api/zapmail/sync')).status === 409, r.json);
    r = await call('GET', '/api/cron/zapmail', null, { noCookie: true, headers: { Authorization: 'Bearer ' + CRON_SECRET } });
    check('cron: with Zapmail disconnected it does nothing and says so', r.status === 200 && r.json.synced === false, r.json);
    const afterDelete = await wholeDatabaseText();
    check('zapmail: the last numbers stay on the Email page after disconnecting', (await call('GET', '/api/email')).json.snapshot.mailboxes.length === 3 && !afterDelete.includes(ZM_KEY), 1);
    void beforeSnap;

    /* ---------- pipeline board ---------- */
    const pl = (await call('GET', '/api/pipeline')).json;
    check('pipeline: board is Replied, Call booked, Follow up, Proposal sent, Closed', JSON.stringify(pl.board) === JSON.stringify(['replied', 'call_booked', 'follow_up', 'proposal_sent', 'closed']) && !('contacted' in pl.columns), pl.board);
    check('pipeline: New and Not interested are counted but not columns', pl.counts.new >= 1 && 'not_interested' in pl.counts && !pl.columns.new, pl.counts);
    check('pipeline: Follow up column holds the leads waiting on a follow-up', pl.counts.follow_up >= 15 && pl.columns.follow_up.length === Math.min(80, pl.counts.follow_up), pl.counts);

    /* ---------- deals and goal ---------- */
    const tz = (await call('GET', '/api/leads?q=TZ Central')).json.rows[0];
    r = await call('PUT', `/api/leads/${tz.id}/deal`, { call_at_local: '2026-12-01T10:00', call_result: 'pending', deal_value: 1200 });
    check('booked call time is stored as UTC from SAST (10:00 SAST = 08:00Z)', r.json.deal.call_at === '2026-12-01T08:00:00.000Z', r.json.deal);
    check('booking a call moves status to Call booked', r.json.lead.status === 'call_booked', r.json.lead.status);
    const g0 = (await call('GET', '/api/pipeline')).json.goal;
    r = await call('PUT', `/api/leads/${tz.id}/deal`, { call_result: 'show', proposal_sent_date: '2026-12-02', deposit_paid_date: '2026-12-03', deposit_amount: 600, signed_date: '2026-12-03' });
    check('signed deal closes the lead', r.json.lead.status === 'closed', r.json.lead.status);
    const g1 = (await call('GET', '/api/pipeline')).json.goal;
    check('goal progress rose by the deal value', g1.signed - g0.signed === 1200 && g1.amount === 20000 && g1.date === '2026-12-31', [g0, g1]);
    check('deposit is counted separately', g1.deposits - g0.deposits === 600, [g0.deposits, g1.deposits]);

    /* ---------- stats ---------- */
    const st = (await call('GET', '/api/stats')).json;
    const callRow = st.byChannel.find((x) => x.channel === 'call');
    check('stats: call attempts counted by channel', callRow.attempts >= 5, callRow);
    check('stats: today appears in the daily series with calls', st.daily[st.daily.length - 1].day === st.today && st.daily[st.daily.length - 1].calls >= 1, st.daily[st.daily.length - 1]);
    check('stats: weekly series has 8 weeks', st.weekly.length === 8, st.weekly.length);
    check('stats: conversion by source is present', st.bySource.find((x) => x.source === 'google_maps').leads > 0, st.bySource);
    check('stats: show rate reflects the deal marked as showed', st.shows >= 1, [st.shows, st.noshows]);

    /* ---------- settings ---------- */
    r = await call('PUT', '/api/settings', { daily_call_target: 60, daily_dm_target: 25 });
    check('daily targets can be changed', r.json.daily_call_target === 60 && r.json.daily_dm_target === 25, r.json);
    check('targets start at 50 calls and 30 DMs by default', (await call('GET', '/api/settings')).json.daily_call_target === 60, 1);

    /* ---------- owner odds (HIGH, MEDIUM, LOW) ---------- */
    const mkOdds = async (name, extra) => (await call('POST', '/api/leads', { business_name: name, city: 'Oddsville', state: 'NY', batch: 'Odds test', ...extra })).json.lead;
    let olead = await mkOdds('Odds Norm A', { owner_odds: 'High', owner_odds_score: '85' });
    check('owner odds: "High" is saved as HIGH and the score as a whole number', olead.owner_odds === 'HIGH' && olead.owner_odds_score === 85, [olead.owner_odds, olead.owner_odds_score]);
    const oddsCases = [['med', 'MEDIUM'], ['medium', 'MEDIUM'], [' low ', 'LOW'], ['HIGH', 'HIGH'], ['maybe', null], ['', null], ['very high', null], [7, null], [null, null]];
    let okCases = true; const badCases = [];
    for (const [input, want] of oddsCases) { const x = await mkOdds('Odds Case ' + JSON.stringify(input), { owner_odds: input }); if (x.owner_odds !== want) { okCases = false; badCases.push([input, x.owner_odds]); } }
    check('owner odds: "med", "medium", " low ", "HIGH" are understood, anything else becomes empty', okCases, badCases);
    let okScores = true; const badScores = [];
    for (const [input, want] of [[0, 0], [100, 100], ['64', 64], [101, null], [-1, null], [7.5, null], ['abc', null], ['', null], [true, null]]) { const x = await mkOdds('Odds Score ' + JSON.stringify(input), { owner_odds: 'LOW', owner_odds_score: input }); if (x.owner_odds_score !== want) { okScores = false; badScores.push([input, x.owner_odds_score]); } }
    check('owner odds score: only a whole number from 0 to 100 is kept, anything else becomes empty', okScores, badScores);
    r = await call('PATCH', '/api/leads/' + olead.id, { owner_odds: 'low' });
    check('owner odds can be changed on an existing lead (score kept)', r.json.lead.owner_odds === 'LOW' && r.json.lead.owner_odds_score === 85, r.json.lead);
    r = await call('PATCH', '/api/leads/' + olead.id, { notes: 'just a note' });
    check('saving other fields does not wipe the odds', r.json.lead.owner_odds === 'LOW' && r.json.lead.owner_odds_score === 85, r.json.lead);
    r = await call('PATCH', '/api/leads/' + olead.id, { owner_odds: '' });
    check('clearing the odds clears the score with it', r.json.lead.owner_odds === null && r.json.lead.owner_odds_score === null, r.json.lead);
    r = await call('POST', '/api/leads/check', { business_name: 'Whatever', owner_odds: 'HIGH' });
    check('the duplicate check accepts the new field', r.status === 200, r.status);

    /* import with the two new columns */
    const oddsRows = [
      { business_name: 'Odds Imp High', phone: '(555) 310-0001', city: 'Importville', state: 'PA', owner_odds: 'HIGH', owner_odds_score: '90' },
      { business_name: 'Odds Imp Mid', phone: '(555) 310-0002', city: 'Importville', state: 'PA', owner_odds: 'medium', owner_odds_score: 55 },
      { business_name: 'Odds Imp Low', phone: '(555) 310-0003', city: 'Importville', state: 'PA', owner_odds: 'Low', owner_odds_score: '12' },
      { business_name: 'Odds Imp Junk', phone: '(555) 310-0004', city: 'Importville', state: 'PA', owner_odds: 'unknown', owner_odds_score: '250' },
      { business_name: 'Odds Imp None', phone: '(555) 310-0005', city: 'Importville', state: 'PA' },
    ];
    r = await call('POST', '/api/import/preview', { rows: oddsRows, defaults: { source: 'google_maps', batch: 'Odds import' } });
    check('import preview shows the odds it understood and nothing for junk', r.json.counts.new === 5 && r.json.rows[0].lead.owner_odds === 'HIGH' && r.json.rows[0].lead.owner_odds_score === 90 && r.json.rows[1].lead.owner_odds === 'MEDIUM' && r.json.rows[3].lead.owner_odds === null && r.json.rows[3].lead.owner_odds_score === null, r.json.rows && r.json.rows.map((x) => [x.lead.owner_odds, x.lead.owner_odds_score]));
    r = await call('POST', '/api/import/commit', { rows: oddsRows, defaults: { source: 'google_maps', batch: 'Odds import' }, mode: 'skip' });
    check('import with the odds columns adds every orow', r.json.added === 5, r.json);
    const ODDS_BATCH = '&batch=' + encodeURIComponent('Odds import');
    let oimp = (await call('GET', '/api/leads?sort=odds' + ODDS_BATCH)).json.rows;
    check('imported odds and scores are stored', oimp.map((x) => x.business_name + ':' + x.owner_odds + ':' + x.owner_odds_score).join('|') === 'Odds Imp High:HIGH:90|Odds Imp Mid:MEDIUM:55|Odds Imp Low:LOW:12|Odds Imp None:null:null|Odds Imp Junk:null:null', oimp.map((x) => [x.business_name, x.owner_odds, x.owner_odds_score]));
    /* update mode only fills what is empty */
    const upRows = [
      { business_name: 'Odds Imp High', phone: '(555) 310-0001', city: 'Importville', state: 'PA', owner_odds: 'LOW', owner_odds_score: '5' },
      { business_name: 'Odds Imp Junk', phone: '(555) 310-0004', city: 'Importville', state: 'PA', owner_odds: 'MEDIUM', owner_odds_score: '48' },
      { business_name: 'Odds Imp None', phone: '(555) 310-0005', city: 'Importville', state: 'PA', owner_odds: 'HIGH' },
    ];
    r = await call('POST', '/api/import/commit', { rows: upRows, defaults: { source: 'google_maps', batch: 'Odds import' }, mode: 'update' });
    check('update mode: two leads gained odds, the one that already had odds was left alone', r.json.updated === 2 && r.json.skipped_duplicates === 1, r.json);
    oimp = (await call('GET', '/api/leads?sort=odds' + ODDS_BATCH)).json.rows;
    const oby = Object.fromEntries(oimp.map((x) => [x.business_name, x]));
    check('update mode never overwrites existing odds or score', oby['Odds Imp High'].owner_odds === 'HIGH' && oby['Odds Imp High'].owner_odds_score === 90, oby['Odds Imp High']);
    check('update mode fills empty odds together with their score', oby['Odds Imp Junk'].owner_odds === 'MEDIUM' && oby['Odds Imp Junk'].owner_odds_score === 48 && oby['Odds Imp None'].owner_odds === 'HIGH' && oby['Odds Imp None'].owner_odds_score === null, [oby['Odds Imp Junk'].owner_odds, oby['Odds Imp Junk'].owner_odds_score, oby['Odds Imp None'].owner_odds]);
    r = await call('POST', '/api/import/commit', { rows: [{ business_name: 'Odds Imp Mid', phone: '(555) 310-0002', city: 'Importville', state: 'PA', owner_odds: 'MEDIUM', owner_odds_score: '77' }, { business_name: 'Odds Imp Low', phone: '(555) 310-0003', city: 'Importville', state: 'PA', owner_odds: 'HIGH', owner_odds_score: '77' }], defaults: {}, mode: 'update' });
    check('update mode: a score alone fills in only when it belongs to the same odds (here it did not, so nothing changed)', r.json.updated === 0 && r.json.skipped_duplicates === 2, r.json);

    /* filter and sort */
    const oddsIds = Object.fromEntries(oimp.map((x) => [x.business_name, x.id]));
    r = await call('GET', '/api/leads?owner_odds=HIGH' + ODDS_BATCH);
    check('filter owner_odds=HIGH', r.json.total === 2 && r.json.rows.every((x) => x.owner_odds === 'HIGH'), r.json.total);
    r = await call('GET', '/api/leads?owner_odds=low' + ODDS_BATCH);
    check('filter accepts lower case (owner_odds=low)', r.json.total === 1 && r.json.rows[0].business_name === 'Odds Imp Low', r.json.total);
    r = await call('GET', '/api/leads?owner_odds=none' + ODDS_BATCH);
    check('filter owner_odds=none lists only leads with no odds', r.json.total === 0 && (await call('GET', '/api/leads?owner_odds=none&limit=1')).json.total > 5, r.json.total);
    r = await call('GET', '/api/leads?owner_odds=bogus' + ODDS_BATCH);
    check('an unknown odds value in the filter is ignored, not an error', r.status === 200 && r.json.total === 5, r.status);
    // a mixed batch for the sort
    for (const [n, o, s] of [['Sort Low 99', 'LOW', 99], ['Sort None', null, null], ['Sort Med 70', 'MEDIUM', 70], ['Sort High 60', 'HIGH', 60], ['Sort High none', 'HIGH', null], ['Sort High 90', 'HIGH', 90]]) await mkOdds(n, { batch: 'Odds sort', owner_odds: o, owner_odds_score: s });
    const sortedNames = async (extra) => (await call('GET', '/api/leads?batch=' + encodeURIComponent('Odds sort') + '&sort=odds' + (extra || ''))).json.rows.map((x) => x.business_name);
    const wantSort = ['Sort High 90', 'Sort High 60', 'Sort High none', 'Sort Med 70', 'Sort Low 99', 'Sort None'];
    check('sort=odds: HIGH first, then MEDIUM, LOW, none; best score first inside each; no score last', JSON.stringify(await sortedNames()) === JSON.stringify(wantSort), await sortedNames());
    const p1 = await sortedNames('&limit=2&offset=0'), p2 = await sortedNames('&limit=2&offset=2'), p3 = await sortedNames('&limit=2&offset=4');
    check('sort=odds keeps pagination working (pages join up with no repeats)', JSON.stringify([...p1, ...p2, ...p3]) === JSON.stringify(wantSort), [p1, p2, p3]);
    r = await call('GET', '/api/leads?batch=' + encodeURIComponent('Odds sort') + '&sort=odds&owner_odds=HIGH&limit=2');
    check('filter and sort work together, total counts the whole filter', r.json.total === 3 && r.json.rows.length === 2 && r.json.rows[0].business_name === 'Sort High 90', r.json.total);

    /* calls queue order: same leads, same counts, only the order changes */
    const NOWQ = '2026-11-24T14:00:00Z';
    const qNames = (t) => t.queue.ready.filter((x) => x.business_name.startsWith('Qodds ')).map((x) => x.business_name);
    let qn = 0;
    for (const [n, o, s] of [['Qodds 1 none', null, null], ['Qodds 2 low', 'LOW', 60], ['Qodds 3 high 40', 'HIGH', 40], ['Qodds 4 med', 'MEDIUM', 80], ['Qodds 5 high 90', 'HIGH', 90]]) {
      qn++;
      await call('POST', '/api/leads', { business_name: n, phone: '(555) 320-' + String(1000 + qn), city: 'Queueville', state: 'NY', owner_odds: o, owner_odds_score: s });
    }
    const tqo = (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(NOWQ))).json;
    check('calls queue: HIGH first, then MEDIUM, then LOW, then no odds, and the old order (by id) inside each', JSON.stringify(qNames(tqo)) === JSON.stringify(['Qodds 3 high 40', 'Qodds 5 high 90', 'Qodds 4 med', 'Qodds 2 low', 'Qodds 1 none']), qNames(tqo));
    const rk = (o) => (o === 'HIGH' ? 0 : o === 'MEDIUM' ? 1 : o === 'LOW' ? 2 : 3);
    check('calls queue: the whole ready list is in odds order', tqo.queue.ready.every((x, i, a) => i === 0 || rk(a[i - 1].owner_odds) <= rk(x.owner_odds)) && tqo.queue.ready[0].owner_odds === 'HIGH', tqo.queue.ready.map((x) => x.owner_odds));
    const obefore = { ready: tqo.queue.ready_total, later: tqo.queue.later_total, no_tz: tqo.queue.no_tz_total };
    await db.run('UPDATE leads SET owner_odds = NULL, owner_odds_score = NULL');
    const tqn = (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(NOWQ))).json;
    check('calls queue: odds change only the order, never who is in it or the counts', tqn.queue.ready_total === obefore.ready && tqn.queue.later_total === obefore.later && tqn.queue.no_tz_total === obefore.no_tz && tqn.queue.ready.map((x) => x.id).sort((a, b) => a - b).join() === tqo.queue.ready.map((x) => x.id).sort((a, b) => a - b).join(), [obefore, tqn.queue.ready_total]);
    check('calls queue: with no odds anywhere the order is the original one (least time left, then id)', tqn.queue.ready.every((x, i, a) => i === 0 || a[i - 1].window.minsLeft < x.window.minsLeft || (a[i - 1].window.minsLeft === x.window.minsLeft && a[i - 1].id < x.id)), 1);
    check('queue and follow-up rows carry the odds fields', 'owner_odds' in tqn.queue.ready[0] && 'owner_odds_score' in tqn.queue.ready[0] && 'owner_odds' in (await call('GET', '/api/followups?limit=1')).json.rows[0], 1);
    // put some odds back for the export and migration checks
    await call('PATCH', '/api/leads/' + oddsIds['Odds Imp High'], { owner_odds: 'HIGH', owner_odds_score: 90 });
    await call('PATCH', '/api/leads/' + oddsIds['Odds Imp Mid'], { owner_odds: 'MEDIUM', owner_odds_score: 55 });
    const todayOdds = (await call('GET', '/api/today')).json.progress.today;
    const fuOdds = (await call('PATCH', '/api/leads/' + oddsIds['Odds Imp Low'], { owner_odds: 'LOW', owner_odds_score: 12, next_followup: todayOdds })).json.lead;
    const fuList = (await call('GET', '/api/followups?limit=300')).json.rows.find((x) => x.id === fuOdds.id);
    check('follow-ups show the owner odds of each lead', fuList && fuList.owner_odds === 'LOW' && fuList.owner_odds_score === 12, fuList);
    const oddsCsv = Lib.parseCSV((await call('GET', '/api/export/leads.csv')).buf.toString('utf8'));
    const ohdr = oddsCsv[0], orow = oddsCsv.find((x) => x[1] === 'Odds Imp High');
    check('the leads CSV export has owner_odds and owner_odds_score columns with the values', ohdr.includes('owner_odds') && ohdr.includes('owner_odds_score') && orow[ohdr.indexOf('owner_odds')] === 'HIGH' && orow[ohdr.indexOf('owner_odds_score')] === '90', [ohdr.slice(12, 16), orow && orow.slice(12, 16)]);
    const rowNone = oddsCsv.find((x) => x[1] === 'Ridgeline Roofing');
    check('a lead without odds exports empty cells', rowNone && rowNone[ohdr.indexOf('owner_odds')] === '' && rowNone[ohdr.indexOf('owner_odds_score')] === '', rowNone);

    /* the migration: an existing production table has no odds columns; the next start must add them and touch nothing else */
    const nBefore = (await db.get('SELECT COUNT(*) AS n FROM leads')).n;
    const sampleSql = "SELECT id, business_name, phone, status, notes, created_at FROM leads WHERE business_name = 'Ridgeline Roofing'";
    const sampleBefore = await db.get(sampleSql);
    await db.exec('ALTER TABLE leads DROP COLUMN owner_odds; ALTER TABLE leads DROP COLUMN owner_odds_score;');
    const colsOf = async () => (await db.all("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leads' AND column_name LIKE 'owner_odds%' ORDER BY column_name")).map((c) => c.column_name + ':' + c.data_type + ':' + c.is_nullable).join();
    check('(setup) the old production shape has no odds columns', (await colsOf()) === '', await colsOf());
    resetSchemaFlag(); await app.init();
    check('migration: the odds columns are added to the existing table (TEXT and INTEGER, both optional)', (await colsOf()) === 'owner_odds:text:YES,owner_odds_score:integer:YES', await colsOf());
    check('migration: existing leads are untouched and the odds start empty', (await db.get('SELECT COUNT(*) AS n FROM leads')).n === nBefore && JSON.stringify(await db.get(sampleSql)) === JSON.stringify(sampleBefore) && (await db.get('SELECT COUNT(*) AS n FROM leads WHERE owner_odds IS NOT NULL')).n === 0, 1);
    await call('PATCH', '/api/leads/' + oddsIds['Odds Imp High'], { owner_odds: 'HIGH', owner_odds_score: 90 });
    resetSchemaFlag(); await app.init(); resetSchemaFlag(); await app.init();
    check('migration: running it again is harmless and keeps the data', (await colsOf()) === 'owner_odds:text:YES,owner_odds_score:integer:YES' && (await db.get('SELECT owner_odds, owner_odds_score FROM leads WHERE id = ?', oddsIds['Odds Imp High'])).owner_odds === 'HIGH', 1);
    await db.exec('ALTER TABLE leads DROP COLUMN owner_odds_score');
    resetSchemaFlag(); await app.init();
    check('migration: a half-done table (only one of the two columns) is completed too', (await colsOf()) === 'owner_odds:text:YES,owner_odds_score:integer:YES', await colsOf());
    check('migration: Row Level Security stays on for leads, with no policies', (await db.get("SELECT relrowsecurity FROM pg_class WHERE relname = 'leads' AND relkind = 'r'")).relrowsecurity === true && (await db.all("SELECT * FROM pg_policies WHERE schemaname = 'public'")).length === 0, 1);
    await call('PATCH', '/api/leads/' + oddsIds['Odds Imp High'], { owner_odds: 'HIGH', owner_odds_score: 90 });

    {
    /* ---------- my day starts at 3 AM (day_start_hour), not midnight ---------- */
    const SAST = 'Africa/Johannesburg';
    check('day start: Lib.myDayKey keeps 00:00 to 02:59 SAST in the day before and starts the new day at 03:00', Lib.myDayKey('2027-03-09T23:30:00Z', SAST, 3) === '2027-03-09' && Lib.myDayKey('2027-03-10T00:59:59Z', SAST, 3) === '2027-03-09' && Lib.myDayKey('2027-03-10T01:00:00Z', SAST, 3) === '2027-03-10' && Lib.myDayKey('2027-03-10T01:05:00Z', SAST, 3) === '2027-03-10', 1);
    check('day start: 0 is the old midnight behaviour, 6 and 9 are limited to 0 to 6, a missing hour behaves like 0', Lib.myDayKey('2027-03-09T23:30:00Z', SAST, 0) === '2027-03-10' && Lib.myDayKey('2027-03-10T03:59:00Z', SAST, 6) === '2027-03-09' && Lib.myDayKey('2027-03-10T04:00:00Z', SAST, 9) === '2027-03-10' && Lib.myDayKey('2027-03-09T23:30:00Z', SAST) === Lib.dayKey('2027-03-09T23:30:00Z', SAST), 1);
    check('day start: Lib.dayKey itself is unchanged (a lead\'s own clock never moves)', Lib.dayKey('2027-03-09T23:30:00Z', SAST) === '2027-03-10' && Lib.dayKey('2027-03-10T00:30:00Z', 'America/New_York') === '2027-03-09', 1);
    r = await call('GET', '/api/settings');
    check('day start: the setting is there and defaults to 3', r.json.day_start_hour === 3, r.json.day_start_hour);
    for (const bad of [7, -1, 2.5, 'abc', '']) {
      r = await call('PUT', '/api/settings', { day_start_hour: bad });
      if (r.status !== 400) check('day start: ' + JSON.stringify(bad) + ' is refused', false, r.status);
    }
    check('day start: values outside 0 to 6, fractions and text are refused and the setting stays 3', (await call('GET', '/api/settings')).json.day_start_hour === 3, 1);
    const dsLead = (await call('POST', '/api/leads', { business_name: 'Day Start Test Plumbing', phone: '(555) 340-0001', city: 'Dayville', state: 'NY' })).json.lead;
    const NOW_0230 = '2027-03-10T00:30:00Z';  // 02:30 SAST on 10 March: still the 9th with a 3 AM start
    const NOW_1000 = '2027-03-10T08:00:00Z';  // 10:00 SAST on 10 March
    const logAt = (channel, outcome, at, now) => call('POST', '/api/leads/' + dsLead.id + '/contacts?now=' + encodeURIComponent(now), { channel, outcome, at, followup: null });
    await logAt('call', 'voicemail', '2027-03-09T23:30:00Z', NOW_1000);   // 01:30 SAST on the 10th
    await logAt('call', 'voicemail', '2027-03-10T01:05:00Z', NOW_1000);   // 03:05 SAST on the 10th
    await logAt('instagram_dm', 'sent', '2027-03-09T23:40:00Z', NOW_1000);
    await logAt('email', 'sent', '2027-03-10T00:10:00Z', NOW_1000);
    await logAt('facebook_dm', 'sent', '2027-03-10T01:30:00Z', NOW_1000);
    const dayCalls = async (day, now) => (await call('GET', '/api/calls/day?day=' + day + '&now=' + encodeURIComponent(now))).json;
    let d9 = await dayCalls('2027-03-09', NOW_1000), d10 = await dayCalls('2027-03-10', NOW_1000);
    check('day start 3: a call at 01:30 SAST counts in the previous day, one at 03:05 in the new day', d9.auto.calls === 1 && d10.auto.calls === 1 && d9.is_today === false && d10.is_today === true, [d9.auto, d10.auto]);
    let o9 = (await call('GET', '/api/outreach/day?day=2027-03-09&now=' + encodeURIComponent(NOW_1000))).json, o10 = (await call('GET', '/api/outreach/day?day=2027-03-10&now=' + encodeURIComponent(NOW_1000))).json;
    const oc = (o, k) => o.items.find((i) => i.key === k).total;
    check('day start 3: Reached out today counters follow it too (call, Instagram, Facebook, email)', oc(o9, 'call') === 1 && oc(o9, 'instagram_dm') === 1 && oc(o9, 'email') === 1 && oc(o9, 'facebook_dm') === 0 && oc(o10, 'call') === 1 && oc(o10, 'instagram_dm') === 0 && oc(o10, 'email') === 0 && oc(o10, 'facebook_dm') === 1, [o9.items.map((i) => i.total), o10.items.map((i) => i.total)]);
    let t = (await call('GET', '/api/today?now=' + encodeURIComponent(NOW_0230))).json;
    check('day start 3: at 02:30 SAST Today is still the previous day, with its counters', t.progress.today === '2027-03-09' && t.progress.calls === 1, [t.progress.today, t.progress.calls]);
    t = (await call('GET', '/api/today?now=' + encodeURIComponent(NOW_1000))).json;
    check('day start 3: at 10:00 SAST Today is the new day', t.progress.today === '2027-03-10' && t.progress.calls === 1, [t.progress.today, t.progress.calls]);
    r = await call('GET', '/api/calls?now=' + encodeURIComponent(NOW_0230));
    check('day start 3: the Calls page, dials meter and last 14 days use the same day', r.json.today === '2027-03-09' && r.json.dials_today === 1 && r.json.daily[13].day === '2027-03-09' && r.json.daily[13].dials === 1, [r.json.today, r.json.dials_today]);
    r = await call('GET', '/api/stats?now=' + encodeURIComponent(NOW_0230));
    check('day start 3: Stats days end on the same day', r.json.today === '2027-03-09' && r.json.daily[r.json.daily.length - 1].day === '2027-03-09', [r.json.today, r.json.daily.length && r.json.daily[r.json.daily.length - 1].day]);
    r = await call('PUT', '/api/calls/day?now=' + encodeURIComponent(NOW_0230), { day: '2027-03-10', field: 'calls', value: 5 });
    check('day start 3: at 02:30 SAST you cannot log the 10th yet ("has not happened yet"), but you can log the 9th', r.status === 400 && /not happened/.test(r.json.error) && (await call('PUT', '/api/calls/day?now=' + encodeURIComponent(NOW_0230), { day: '2027-03-09', field: 'calls', value: 4 })).status === 200, r.status);
    await call('PUT', '/api/calls/day?now=' + encodeURIComponent(NOW_0230), { day: '2027-03-09', field: 'calls', value: 1 }); // put the adjustment back
    r = await call('POST', '/api/leads/' + dsLead.id + '/contacts?now=' + encodeURIComponent(NOW_0230), { channel: 'call', outcome: 'no_answer' });
    const wantFollow = Lib.addBizDays('2027-03-09', Lib.FOLLOWUP_DAYS.no_answer);
    check('day start 3: a follow-up set automatically at 02:30 SAST counts from the previous day', r.status === 200 && r.json.lead.next_followup === wantFollow, [r.json.lead && r.json.lead.next_followup, wantFollow]);
    // the lead's own clock is exact whatever the start hour is
    const dsQ = (await call('POST', '/api/leads', { business_name: 'Day Start Queue Test', phone: '(555) 340-0002', city: 'Dayville', state: 'NY' })).json.lead;
    const qAt = async () => (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(NOW_0230))).json.queue;
    const q3 = await qAt();
    const dsRow3 = [...q3.ready, ...q3.later].find((x) => x.id === dsQ.id);
    r = await call('PUT', '/api/settings', { day_start_hour: 0 });
    check('day start: it can be set to 0 (the old behaviour)', r.json.day_start_hour === 0, r.json);
    const q0 = await qAt();
    const dsRow0 = [...q0.ready, ...q0.later].find((x) => x.id === dsQ.id);
    check('day start never moves a lead\'s local clock: the calling window, local time and the queue are the same with 3 and 0', dsRow3 && dsRow0 && JSON.stringify(dsRow3.window) === JSON.stringify(dsRow0.window) && dsRow3.window.local === dsRow0.window.local && q3.ready_total === q0.ready_total && q3.later_total === q0.later_total && q3.no_tz_total === q0.no_tz_total, [dsRow3 && dsRow3.window, dsRow0 && dsRow0.window]);
    check('day start: the lead in New York is 19:30 local at 00:30 UTC and ready to call whichever day start is set', dsRow0 && dsRow0.window.ok === true && /7:30/.test(dsRow0.window.local), dsRow0 && dsRow0.window);
    d9 = await dayCalls('2027-03-09', NOW_1000); d10 = await dayCalls('2027-03-10', NOW_1000);
    check('day start 0 (old behaviour): the same history re-buckets by midnight with no migration (01:30 SAST is now the 10th)', d9.auto.calls === 0 && d10.auto.calls === 2, [d9.auto.calls, d10.auto.calls]);
    o9 = (await call('GET', '/api/outreach/day?day=2027-03-09&now=' + encodeURIComponent(NOW_1000))).json; o10 = (await call('GET', '/api/outreach/day?day=2027-03-10&now=' + encodeURIComponent(NOW_1000))).json;
    check('day start 0: Instagram and email at 01:30 and 02:10 SAST move to the 10th', oc(o9, 'instagram_dm') === 0 && oc(o9, 'email') === 0 && oc(o10, 'instagram_dm') === 1 && oc(o10, 'email') === 1, [o9.items.map((i) => i.total), o10.items.map((i) => i.total)]);
    t = (await call('GET', '/api/today?now=' + encodeURIComponent(NOW_0230))).json;
    check('day start 0: at 02:30 SAST Today is the new calendar day', t.progress.today === '2027-03-10', t.progress.today);
    r = await call('PUT', '/api/calls/day?now=' + encodeURIComponent(NOW_0230), { day: '2027-03-10', field: 'calls', value: 2 });
    check('day start 0: logging the 10th at 02:30 SAST is allowed again', r.status === 200, r.status);
    r = await call('PUT', '/api/settings', { day_start_hour: 6 });
    check('day start: 6 is accepted (the top of the range)', r.json.day_start_hour === 6, r.json);
    r = await call('PUT', '/api/settings', { day_start_hour: '3' });
    check('day start: back to 3 (a number typed as text is fine)', r.json.day_start_hour === 3 && typeof r.json.day_start_hour === 'number', r.json);
    await call('DELETE', '/api/leads/' + dsLead.id + '?confirm=1');
    await call('DELETE', '/api/leads/' + dsQ.id + '?confirm=1');
    await db.run("DELETE FROM call_day WHERE day IN ('2027-03-09', '2027-03-10')");
    }

    /* ---------- ranking data (rank_info): where a lead ranks on Google Maps and who is ahead ---------- */
    const RI = { query: 'plumber in Norristown PA', my_rank: 5, total: 79, top3: [{ rank: 1, name: 'Valdel Plumbing', rating: 4.8, reviews: 1094, phone: '+1 484-246-6888' }, { rank: 2, name: 'Ray Ross Plumbing & Heating', rating: 4.7, reviews: 68, phone: '+1 267-228-7287' }, { rank: 3, name: 'Plumb it Heat it Cool it', rating: 4.9, reviews: 858, phone: null }], source: 'google-maps-scrape', checked_at: '2026-11-25' };
    r = await call('POST', '/api/leads', { business_name: 'Rank Test Plumbing', phone: '(555) 330-0001', website: 'https://ranktest.example', city: 'Queueville', state: 'NY', owner_name: 'Rex Rank', owner_odds: 'HIGH', rank_info: RI });
    const rkLead = r.json.lead;
    check('rank_info: a lead can be saved with ranking data and it comes back as an object', r.status === 200 && require('node:util').isDeepStrictEqual(rkLead.rank_info, RI), r.json);
    r = await call('GET', '/api/leads/' + rkLead.id);
    check('rank_info: the single lead endpoint returns it', r.json.lead.rank_info && r.json.lead.rank_info.my_rank === 5 && r.json.lead.rank_info.top3.length === 3 && r.json.lead.rank_info.top3[0].name === 'Valdel Plumbing', r.json.lead.rank_info);
    r = await call('GET', '/api/leads?q=Rank%20Test%20Plumbing');
    check('rank_info: the Leads list stays light (no ranking object, only a yes/no flag)', r.json.rows.length === 1 && !('rank_info' in r.json.rows[0]) && r.json.rows[0].has_rank_info === true, r.json.rows[0]);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { notes: 'edited' });
    check('rank_info: saving other fields does not wipe it', r.json.lead.rank_info && r.json.lead.rank_info.my_rank === 5, r.json.lead.rank_info);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: JSON.stringify({ ...RI, my_rank: 7 }) });
    check('rank_info: ranking data can be sent as a JSON string too', r.status === 200 && r.json.lead.rank_info.my_rank === 7, r.json);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: 'not json at all' });
    check('rank_info: junk is refused with a clear message', r.status === 400 && /Ranking data/.test(r.json.error), [r.status, r.json]);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: { query: 'x', my_rank: 0 } });
    check('rank_info: a rank below 1 is refused', r.status === 400, r.status);
    r = await call('GET', '/api/leads/' + rkLead.id);
    check('rank_info: a refused save leaves the old data in place', r.json.lead.rank_info.my_rank === 7, r.json.lead.rank_info);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: { ...RI, total: 3, top3: [...RI.top3, { rank: 4, name: 'Extra' }], checked_at: 'yesterday' } });
    check('rank_info: a total below the rank, a fourth competitor and a bad date are cleaned', r.status === 200 && r.json.lead.rank_info.total === null && r.json.lead.rank_info.top3.length === 3 && r.json.lead.rank_info.checked_at === null, r.json.lead && r.json.lead.rank_info);
    await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: RI });
    const tqr = (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(NOWQ))).json;
    const qr = tqr.queue.ready.find((x) => x.id === rkLead.id);
    check('rank_info: the call queue row carries the ranking and the website for the Open panel', qr && qr.rank_info && qr.rank_info.top3.length === 3 && qr.website === 'https://ranktest.example' && qr.owner_name === 'Rex Rank', qr);
    check('rank_info: a queue row with no ranking has null, not a missing field', tqr.queue.ready.some((x) => x.id !== rkLead.id && x.rank_info === null), 1);
    check('rank_info: the rows below the fold (outside hours, no time zone) stay slim', [...tqr.queue.later, ...tqr.queue.no_tz].every((x) => !('rank_info' in x) && !('website' in x)), 1);
    check('rank_info: the ranking is not added to Follow-ups or Today', !('rank_info' in (await call('GET', '/api/followups?limit=1')).json.rows[0]) && JSON.stringify((await call('GET', '/api/today')).json).indexOf('top3') === -1, 1);
    r = await call('POST', '/api/import/commit', { rows: [{ business_name: 'Rank Imp A', phone: '(555) 330-0002', city: 'Importville', state: 'PA', rank_info: JSON.stringify(RI) }, { business_name: 'Rank Imp B', phone: '(555) 330-0003', city: 'Importville', state: 'PA', rank_info: 'junk' }, { business_name: 'Rank Imp C', phone: '(555) 330-0004', city: 'Importville', state: 'PA' }], defaults: {}, mode: 'skip' });
    const impR = await db.all("SELECT business_name, rank_info FROM leads WHERE business_name LIKE 'Rank Imp %' ORDER BY business_name");
    check('rank_info: CSV import stores a good rank_info cell, ignores a junk one and keeps the row', r.json.added === 3 && impR[0].rank_info && impR[0].rank_info.my_rank === 5 && impR[1].rank_info === null && impR[2].rank_info === null, impR);
    r = await call('POST', '/api/import/commit', { rows: [{ business_name: 'Rank Imp B', phone: '(555) 330-0003', rank_info: JSON.stringify(RI) }, { business_name: 'Rank Imp A', phone: '(555) 330-0002', rank_info: JSON.stringify({ ...RI, my_rank: 40 }) }], defaults: {}, mode: 'update' });
    const impR2 = await db.all("SELECT business_name, rank_info FROM leads WHERE business_name LIKE 'Rank Imp %' ORDER BY business_name");
    check('rank_info: import in fill-blank mode fills a lead with none and never overwrites one that has it', r.json.updated === 1 && impR2[1].rank_info && impR2[1].rank_info.my_rank === 5 && impR2[0].rank_info.my_rank === 5, impR2.map((x) => x.rank_info && x.rank_info.my_rank));
    const exCsv = Lib.parseCSV((await call('GET', '/api/export/leads.csv')).buf.toString('utf8'));
    const exH = exCsv[0], exRow = exCsv.find((x) => x[1] === 'Rank Test Plumbing');
    check('rank_info: the leads CSV export has a rank_info column with the JSON, empty for leads without', exH.includes('rank_info') && JSON.parse(exRow[exH.indexOf('rank_info')]).my_rank === 5 && exCsv.find((x) => x[1] === 'Rank Imp C')[exH.indexOf('rank_info')] === '', exRow && exRow[exH.indexOf('rank_info')]);
    r = await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: '' });
    check('rank_info: an empty value clears it', r.json.lead.rank_info === null, r.json.lead.rank_info);
    await call('PATCH', '/api/leads/' + rkLead.id, { rank_info: RI });
    await db.exec('ALTER TABLE leads DROP COLUMN rank_info');
    resetSchemaFlag();
    await call('GET', '/api/leads?limit=1');
    const rcol = await db.get("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'rank_info'");
    check('rank_info: migration adds the column to an existing table (jsonb, optional)', rcol && rcol.data_type === 'jsonb' && rcol.is_nullable === 'YES' && (await db.get('SELECT COUNT(*) AS n FROM leads WHERE rank_info IS NOT NULL')).n === 0, rcol);
    resetSchemaFlag();
    await call('GET', '/api/leads?limit=1');
    check('rank_info: running the migration again is harmless', (await db.get('SELECT COUNT(*) AS n FROM leads')).n > 10, 1);

    /* ---------- export, backup ---------- */
    r = await call('GET', '/api/export/all.zip');
    const zip = readZip(r.buf);
    check('export zip contains the four CSVs with valid checksums', ['leads.csv', 'contacts.csv', 'deals.csv', 'opt_outs.csv'].every((f) => zip[f] && zip[f].crcOk), Object.keys(zip));
    check('exported leads include the demo and test leads', zip['leads.csv'].data.toString('utf8').includes('Ridgeline Roofing') && zip['leads.csv'].data.toString('utf8').includes('Import One Plumbing'), 1);
    check('exported contacts include the timeline text', zip['contacts.csv'].data.toString('utf8').includes('Yes send it') || zip['contacts.csv'].data.toString('utf8').includes('Opener'), 1);
    check('exported opt-outs keep the deleted lead record', zip['opt_outs.csv'].data.toString('utf8').includes('Maple Street Roofing'), 1);
    r = await call('POST', '/api/backups/run');
    check('the local backup feature is gone (Supabase keeps the backups, Export is your own copy)', r.status === 404 && (await call('GET', '/api/backups')).status === 404, r.status);
    const liveCount = (await call('GET', '/api/leads?limit=1')).json.total;
    const csvRows = Lib.parseCSV((await call('GET', '/api/export/leads.csv')).buf.toString('utf8'));
    check('the leads CSV export holds every lead (header + one row each)', csvRows.filter((x) => x.length > 1).length === liveCount + 1, [csvRows.length, liveCount]);
    const exportedBack = csvRows.slice(1).find((x) => x[1] === 'Ridgeline Roofing');
    check('the exported CSV can be read back by the Import page rules (name, phone and city are there)', exportedBack && exportedBack[3] === '(615) 555-0142' && exportedBack[6] === 'Nashville', exportedBack);

    /* ---------- Row Level Security: the public anon key must see nothing ---------- */
    const rls = await db.all("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname");
    const policies = await db.all("SELECT * FROM pg_policies WHERE schemaname = 'public'");
    check('Row Level Security is on for every table the app made', rls.length >= 11 && rls.every((t) => t.relrowsecurity === true), rls);
    check('and no policies exist, so no outside role can read or write anything', policies.length === 0, policies);
    await db.exec('ALTER TABLE call_tally DISABLE ROW LEVEL SECURITY');
    resetSchemaFlag();
    await app.init();
    check('if Row Level Security was ever switched off, the next start switches it back on', (await db.get("SELECT relrowsecurity FROM pg_class WHERE relname = 'call_tally' AND relkind = 'r'")).relrowsecurity === true, 1);
    check('every table is one of the known ones (nothing unprotected slipped in)', rls.map((t) => t.relname).sort().join() === require('../src/schema.js').TABLES.slice().sort().join(), rls.map((t) => t.relname));

    /* ---------- password change, logout ---------- */
    r = await call('POST', '/api/password', { old: 'wrong-password', new: 'another-pass-123' });
    check('wrong current password is refused', r.status === 401, r.status);
    const PW2 = PW + '-2';
    r = await call('POST', '/api/password', { old: PW, new: PW2 });
    check('password can be changed', r.status === 200, r.status);
    r = await call('POST', '/api/logout');
    r = await call('GET', '/api/leads');
    check('logging out closes the session', r.status === 401, r.status);
    r = await call('POST', '/api/login', { password: PW }, { noCookie: true });
    check('old password no longer works', r.status === 401, r.status);
    r = await call('POST', '/api/login', { password: PW2 }, { noCookie: true });
    check('new password signs in', r.status === 200, r.status);
    const sessionsBefore = (await db.get('SELECT COUNT(*) AS n FROM sessions')).n;
    check('sessions live in the database, not in memory', sessionsBefore >= 1 && (await db.get("SELECT COUNT(*) AS n FROM settings WHERE key = 'password_hash'")).n === 1, sessionsBefore);
    resetSchemaFlag();
    check('a fresh server instance still knows the session (nothing is kept in memory)', (await call('GET', '/api/leads?limit=1')).status === 200, 1);
    const plain = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW2 }) });
    const plainCookie = plain.headers.getSetCookie()[0] || '';
    check('over plain http (local tries) the cookie is HttpOnly and SameSite=Strict', /HttpOnly/.test(plainCookie) && /SameSite=Strict/.test(plainCookie) && !/Secure/.test(plainCookie), plainCookie);
    const secure = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: PW2 }) });
    const secureCookie = secure.headers.getSetCookie()[0] || '';
    check('behind https (Vercel) the session cookie is Secure, HttpOnly, SameSite=Strict and lasts 30 days', /; Secure/.test(secureCookie) && /HttpOnly/.test(secureCookie) && /SameSite=Strict/.test(secureCookie) && /Max-Age=2592000/.test(secureCookie) && /Path=\//.test(secureCookie), secureCookie);
    const out = await fetch(BASE + '/api/logout', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https', Cookie: secureCookie.split(';')[0] } });
    check('signing out clears the cookie with the same flags', /Max-Age=0/.test(out.headers.getSetCookie()[0] || '') && /; Secure/.test(out.headers.getSetCookie()[0] || ''), out.headers.getSetCookie());
    cookie = '';
    r = await call('POST', '/api/login', { password: PW2 }, { noCookie: true });
    check('signing in again works', r.status === 200 && cookie.startsWith('sid='), r.status);

    /* ---------- big import ---------- */
    const big = Array.from({ length: 2000 }, (_, i) => ({ business_name: 'Bulk Co ' + i, phone: '(555) 7' + String(i).padStart(2, '0') + '-' + String(1000 + i), city: 'Bulkville', state: 'TX', trade: 'Roofer' }));
    let t0 = Date.now();
    r = await call('POST', '/api/import/preview', { rows: big, defaults: { source: 'google_maps', batch: 'Bulk' } });
    const tPrev = Date.now() - t0;
    check('2,000 row preview finishes quickly and finds all new', r.status === 200 && r.json.counts.new === 2000 && tPrev < 8000, [r.json && r.json.counts, tPrev + 'ms']);
    t0 = Date.now();
    r = await call('POST', '/api/import/commit', { rows: big, defaults: { source: 'google_maps', batch: 'Bulk' }, mode: 'skip' });
    check('2,000 row import commits in one go', r.status === 200 && r.json.added === 2000 && (Date.now() - t0) < 15000, [r.json, Date.now() - t0]);
    r = await call('GET', '/api/leads?batch=Bulk&limit=5');
    check('imported batch can be filtered by batch name', r.json.total === 2000, r.json.total);
    t0 = Date.now();
    r = await call('GET', '/api/today');
    check('Today still loads fast with 2,000 more leads', r.status === 200 && (Date.now() - t0) < 3000, Date.now() - t0);
    r = await call('POST', '/api/import/commit', { rows: big, defaults: { source: 'google_maps' }, mode: 'skip' });
    check('importing the same file again adds nothing', r.json.added === 0 && r.json.skipped_duplicates === 2000, r.json);

    /* ---------- login lockout (last, it blocks this machine for 10 minutes) ---------- */
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call('POST', '/api/login', { password: 'nope-' + i }, { noCookie: true })).status;
    check('repeated wrong passwords get locked out (429)', last === 429, last);
    check('the lockout is kept in the database, so it holds across serverless instances', (await db.get("SELECT COUNT(*) AS n FROM login_attempts WHERE ip NOT LIKE 'setup|%'")).n >= 6, 1);
    resetSchemaFlag();
    check('while locked out even the right password is refused', (await call('POST', '/api/login', { password: PW2 }, { noCookie: true })).status === 429, 1);
  } catch (e) {
    check('test run crashed', false, e.stack);
  } finally {
    srv.close(); vercelStyle.close();
    try { mock.close(); } catch (e) { /* ignore */ }
    try { await db.close(); } catch (e) { /* ignore */ }
    if (pgServer) await pgServer.stop();
    const bad = results.filter((x) => !x.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed.`);
    process.exit(bad.length ? 1 : 0);
  }
})();
